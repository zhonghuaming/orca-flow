import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createNativeCli } from './native-cli.mjs'
import { buildKickoff, emptyState, id, invalid, object, STAGES, summarizeTasks, text, truncateUtf8, validateEntity, validateRoles } from './flow-domain.mjs'

const STORAGE = 'flow_native_v1'
export default function activate(orca) { return createFlowWorker(orca) }

/** Single trusted worker owns all writes; panel and Bot output cannot write completion state. */
export async function createFlowWorker(orca, { cli = createNativeCli(), dataDir = join(homedir(), '.orca', 'flow-native', 'requests') } = {}) {
  let state = { ...emptyState(), ...await orca.storage.get(STORAGE) }
  // An interrupted send may already have reached a bot. Never silently resend after reload.
  state = { ...state, runs: state.runs.map((run) => run.status === 'sending' ? { ...run, status: 'unknown', error: '插件在投递过程中重新加载，请核对原生记录，不要自动重发。' } : run) }
  let chain = Promise.resolve()
  const serial = (fn) => {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }
  async function save(next, maxBytes = 224 * 1024) {
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > maxBytes) throw invalid('插件记录已达到安全容量，请先精简业务模板；未提交本次修改。')
    await orca.storage.set(STORAGE, next)
    state = next
    orca.panels.post('flow.changed', state)
    return state
  }
  async function workspaces() {
    const result = await orca.host.call('workspace.list', {})
    if (!Array.isArray(result?.workspaces)) throw new Error('无法读取 Orca 工作区列表。')
    return result.workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch ?? null, projectId: w.projectId ?? null, hostId: w.hostId ?? null, projectName: typeof w.project === 'string' ? w.project : null }))
  }
  async function target(workspaceId) {
    const match = (await workspaces()).find((w) => w.id === workspaceId)
    if (!match?.path) throw invalid('目标工作区不存在或无法确认路径，请重新选择。')
    if (match.hostId !== null && match.hostId !== 'local') throw invalid('当前流程仅支持本机工作区，不能向本机 Bot 派发远端项目。')
    return match
  }
  const updateRun = (run) => save({ ...state, runs: state.runs.map((entry) => entry.id === run.id ? run : entry) })
  orca.panels.handle('flow.getState', async () => ({ ...state, workspaces: await workspaces() }))
  orca.panels.handle('flow.refreshBots', () => serial(async () => save({ ...state, bots: await cli.listBots() })))
  orca.panels.handle('flow.saveRoles', (params) => serial(async () => {
    object(params, ['roles'])
    return save({ ...state, roles: validateRoles(params.roles, await cli.listBots()) })
  }))
  orca.panels.handle('flow.saveEntity', (params) => serial(async () => {
    object(params, ['kind', 'entity'])
    const entity = validateEntity(params.kind, params.entity)
    await target(entity.workspaceId)
    const existing = state[params.kind].find((item) => item.id === entity.id)
    if (existing && existing.workspaceId !== entity.workspaceId) throw invalid('不能跨工作区覆盖相同 ID。')
    for (const [field, kind] of [['sprintId', 'sprints'], ['epicId', 'epics']]) {
      if (params.kind === 'items' && entity[field] && !state[kind].some((entry) => entry.id === entity[field] && entry.workspaceId === entity.workspaceId)) throw invalid('关联迭代或史诗不存在，或属于其他工作区。')
    }
    const list = state[params.kind]
    return save({ ...state, [params.kind]: existing ? list.map((item) => item.id === entity.id ? entity : item) : [...list, entity] }, 160 * 1024)
  }))
  orca.panels.handle('flow.deleteEntity', (params) => serial(async () => {
    object(params, ['kind', 'id', 'workspaceId'])
    if (!['items', 'sprints', 'epics', 'workflows'].includes(params.kind)) throw invalid('未知实体类型。')
    id(params.id)
    const item = state[params.kind].find((entry) => entry.id === params.id && entry.workspaceId === params.workspaceId)
    if (!item) throw invalid('目标不存在或不属于当前工作区。')
    if (['sprints', 'epics'].includes(params.kind) && state.items.some((entry) => entry.workspaceId === item.workspaceId && entry[params.kind === 'sprints' ? 'sprintId' : 'epicId'] === item.id)) throw invalid('请先移除任务关联，再删除此迭代或史诗。')
    return save({ ...state, [params.kind]: state[params.kind].filter((entry) => entry.id !== item.id) })
  }))
  orca.panels.handle('flow.openBoard', async (params) => {
    object(params, ['workspaceId'])
    await target(params.workspaceId)
    if (!orca.host.has('commands.run') || !orca.host.has('workspace.open')) throw new Error('当前 Orca 不支持原生看板入口。')
    await orca.host.call('workspace.open', { workspaceId: params.workspaceId })
    const result = await orca.host.call('commands.run', { action: 'workspace.openBoard' })
    if (result?.ran !== true) throw new Error('Orca 未确认打开看板。')
    return { opened: true }
  })
  orca.panels.handle('flow.launch', (params) => serial(async () => {
    object(params, ['id', 'title', 'goal', 'workspaceId'])
    const request = { id: id(params.id), title: text(params.title, '目标名称', 160), goal: text(params.goal, '任务目标', 50000), workspaceId: text(params.workspaceId, '目标工作区', 500) }
    const previous = state.runs.find((run) => run.id === request.id)
    if (previous) {
      if (previous.title !== request.title || previous.goal !== request.goal || previous.target.id !== request.workspaceId) throw invalid('相同请求 ID 的任务内容已变化，请勿复用。')
      return state
    }
    const resolved = await target(request.workspaceId)
    const roles = validateRoles(state.roles, await cli.listBots())
    const active = state.runs.find((run) => run.target.id === resolved.id && !['completed', 'failed'].includes(run.status))
    if (active) throw invalid(`工作区仍有未核实的流程 ${active.id}，请先核对原生任务。`)
    const run = { id: request.id, title: request.title, goal: request.goal, target: resolved, roles, createdAt: Date.now(), status: 'sending', tasks: [] }
    await save({ ...state, runs: [run, ...state.runs] }, 160 * 1024)
    let attemptedDelivery = false
    try {
      await mkdir(dataDir, { recursive: true })
      const bodyFile = join(dataDir, `${run.id}.md`)
      await writeFile(bodyFile, buildKickoff(run), { encoding: 'utf8', flag: 'wx' })
      attemptedDelivery = true
      const receipt = await cli.send(roles.product, `Flow ${run.id}: ${run.title}`.slice(0, 200), bodyFile)
      return await updateRun({ ...run, status: 'dispatched', messageId: receipt.messageId })
    } catch (error) {
      const detail = String(error.message || error).slice(0, 4000)
      await updateRun({ ...run, status: attemptedDelivery ? 'unknown' : 'failed', error: detail })
      throw new Error(`${attemptedDelivery ? '投递结果尚未确认，不自动重试' : '本地准备失败，未向机器人投递'}：${detail}`, { cause: error })
    }
  }))
  orca.panels.handle('flow.archiveRun', (params) => serial(async () => {
    object(params, ['id'])
    const run = state.runs.find((entry) => entry.id === id(params.id))
    if (!run || !['completed', 'failed'].includes(run.status)) throw invalid('只能归档已结束的流程，不能借归档解除未知投递占用。')
    if (run.archived) return state
    await mkdir(dataDir, { recursive: true })
    const archiveFile = join(dataDir, `${run.id}.archive.json`)
    await writeFile(archiveFile, JSON.stringify(run, null, 2), { encoding: 'utf8', flag: 'wx' })
    return updateRun({ ...run, archived: true, archiveFile, goal: '', tasks: run.tasks.map((task) => ({ ...task, result: truncateUtf8(task.result, 256) })) })
  }))
  orca.panels.handle('flow.refreshRun', (params) => serial(async () => {
    object(params, ['id', 'nativeRunId'])
    const run = state.runs.find((entry) => entry.id === id(params.id))
    if (!run) throw invalid('流程不存在。')
    const currentTarget = await target(run.target.id)
    if (currentTarget.path !== run.target.path || currentTarget.branch !== run.target.branch || currentTarget.projectId !== run.target.projectId || currentTarget.hostId !== run.target.hostId) throw invalid('目标路径、分支或项目已变化，请人工核对后再继续。')
    const prefix = `Flow ${run.id}: `
    const candidates = params.nativeRunId ? [{ id: id(params.nativeRunId) }] : (await cli.listRuns()).filter((entry) => typeof entry.objective === 'string' && entry.objective.startsWith(prefix))
    if (candidates.length !== 1) throw invalid(candidates.length ? '发现重复原生运行，请输入准确 runId 核对。' : '尚未发现原生运行；产品 Bot 可能仍未建立任务，也可填写准确 runId。')
    const info = await cli.getRun(candidates[0].id)
    if (typeof info.objective !== 'string' || !info.objective.startsWith(prefix)) throw invalid('原生运行的关联标记不匹配。')
    const tasks = await cli.listTasks(candidates[0].id)
    const summary = summarizeTasks(tasks)
    const relevant = tasks.filter((task) => STAGES.includes(task.title)).slice(0, 20)
    const evidenceBudget = Math.floor(24 * 1024 / Math.max(1, relevant.length))
    const summaries = relevant.map((task) => ({
      id: id(task.id), title: task.title, status: truncateUtf8(task.status, 100),
      deps: Array.isArray(task.deps) ? task.deps.slice(0, 4).map((dependency) => truncateUtf8(dependency, 120)) : null,
      result: truncateUtf8(task.result, evidenceBudget)
    }))
    return updateRun({ ...run, nativeRunId: candidates[0].id, status: summary.status, message: summary.message, tasks: summaries, checkedAt: Date.now() })
  }))
  await save(state)
}
