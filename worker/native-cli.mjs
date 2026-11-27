import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { id, text, truncateUtf8 } from './flow-domain.mjs'

const execute = promisify(execFile)
const ENV_KEYS = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL'])
export function localCliEnvironment(env = process.env, platform = process.platform) {
  const allowed = Object.fromEntries(Object.entries(env).filter(([key]) => ENV_KEYS.has(key.toUpperCase())))
  if (platform !== 'win32') return allowed
  const profile = env.USERPROFILE || env.HOME || homedir()
  return {
    ...allowed, USERPROFILE: profile, HOME: env.HOME || profile,
    APPDATA: env.APPDATA || join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: env.LOCALAPPDATA || join(profile, 'AppData', 'Local')
  }
}
export function resolveCli(env = process.env, platform = process.platform) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
  return '/usr/local/bin/orca'
}
export function createNativeCli({ executable = resolveCli(), exec = execute, cwd } = {}) {
  async function call(args) {
    let stdout
    try {
      const response = await exec(executable, [...args, '--json'], {
        cwd, env: localCliEnvironment(), shell: false, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
      })
      stdout = response.stdout
    } catch (error) {
      let detail = error.message
      try { detail = JSON.parse(error.stdout).error?.message || detail } catch { /* Preserve original execution error. */ }
      throw new Error(`Orca 命令执行失败：${detail}`, { cause: error })
    }
    let envelope
    try { envelope = JSON.parse(stdout) } catch (error) { throw new Error('Orca 返回了无效 JSON。', { cause: error }) }
    if (envelope?.ok !== true || !envelope.result) throw new Error(`Orca 返回错误：${envelope?.error?.message || '缺少有效结果'}`)
    return envelope.result
  }
  return {
    async listBots() {
      const result = await call(['bot', 'list', '--environment', 'local'])
      if (!Array.isArray(result.bots)) throw new Error('Orca Bot 列表格式无效。')
      return result.bots.map((bot) => ({ id: id(bot.id), name: text(bot.name, 'Bot名称', 200), agent: typeof bot.agent === 'string' ? bot.agent : '', paused: bot.paused === true }))
    },
    async listRuns() {
      const result = await call(['orchestration', 'run-list', '--environment', 'local', '--limit', '100'])
      if (!Array.isArray(result.runs)) throw new Error('Orca 执行记录列表格式无效。')
      return result.runs
    },
    getRun: (runId) => call(['orchestration', 'run-show', '--environment', 'local', '--id', id(runId)]),
    async listTasks(runId) {
      const result = await call(['orchestration', 'task-list', '--environment', 'local', '--run', id(runId), '--full'])
      if (!Array.isArray(result.tasks)) throw new Error('Orca 执行任务列表格式无效。')
      if (result.tasks.length > 100) throw new Error('Orca 执行任务超过本次核对容量（100 条），请缩小运行范围。')
      return result.tasks.map((task) => {
        let deps = task.deps
        if (typeof deps === 'string') {
          try { deps = JSON.parse(deps) } catch { throw new Error('Orca 执行任务依赖 JSON 无效。') }
        }
        if (deps !== undefined && (!Array.isArray(deps) || deps.some((dependency) => typeof dependency !== 'string'))) throw new Error('Orca 执行任务依赖格式无效。')
        return {
          id: id(task.id), title: text(task.task_title ?? task.title, 'Orca 执行任务标题', 500),
          status: text(task.status, 'Orca 执行任务状态', 40), deps: deps ?? null,
          result: typeof task.result === 'string' ? truncateUtf8(task.result, 8000) : ''
        }
      })
    }
  }
}
