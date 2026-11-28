import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { id, text, truncateUtf8 } from './flow-domain.mjs'

const execute = promisify(execFile)
const CLI_TIMEOUT_MS = 20000
const CLI_MAX_OUTPUT_BYTES = 1024 * 1024

// Preserve only a complete read observation; process exit failure is still reported separately.
function completedChatResponse(error, args) {
  const chatList = args.length === 7 && args[0] === 'bot' && args[1] === 'chats' && args[2] === '--environment' && args[3] === 'local' && args[4] === '--bot' && args[6] === '--all'
  if (!chatList || error.code !== null || error.signal !== 'SIGTERM' || error.killed !== true || error.stderr || typeof error.stdout !== 'string' || Buffer.byteLength(error.stdout) > CLI_MAX_OUTPUT_BYTES) return null
  let envelope
  try { envelope = JSON.parse(error.stdout) } catch { return null }
  return envelope?.ok === true && envelope.result && typeof envelope.result === 'object' && !Array.isArray(envelope.result) ? envelope.result : null
}
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
export function createNativeCli({ executable = resolveCli(), exec = execute, cwd, warn = (message) => console.warn(message) } = {}) {
  async function call(args) {
    let stdout
    try {
      const response = await exec(executable, [...args, '--json'], {
        cwd, env: localCliEnvironment(), shell: false, windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_OUTPUT_BYTES
      })
      stdout = response.stdout
    } catch (error) {
      const completed = completedChatResponse(error, args)
      if (completed) {
        warn('Orca 已返回完整只读应答，但客户端未按时结束；保留应答并继续校验聊天列表，未重试命令。')
        return completed
      }
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
    async listBotChats(botId) {
      const result = await call(['bot', 'chats', '--environment', 'local', '--bot', id(botId), '--all'])
      if (!Array.isArray(result.chats) || result.chats.length > 2000) throw new Error('Orca 聊天列表格式无效或超过查询容量（2000 条）。')
      const chats = result.chats.map((chat) => {
        if (!chat || typeof chat.title !== 'string' || chat.title.length > 4096 || chat.title.includes('\0') || typeof chat.closed !== 'boolean') throw new Error('Orca 聊天元数据格式无效。')
        return { id: id(chat.id), title: chat.title, closed: chat.closed }
      })
      return { botName: text(result.bot, 'Bot名称', 200), chats }
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
