import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createNativeCli } from './native-cli.mjs'
import { buildKickoff, emptyState, id, invalid, object, resolveExecutionPlan, ROLE_KEYS, STAGES, summarizeTasks, text, truncateUtf8, validateEntity, validateRoles } from './flow-domain.mjs'

import { event, observed } from './run-history.mjs'
import { DEFAULT_SCOPE } from './execution-plan.mjs'
import { checkPreparedCapacity, persistContract } from './prepared-contract.mjs'

const STORAGE = 'flow_native_v1'
// Native task outcomes do not classify message delivery. In particular, legacy
// records with no explicit classification or platform receipt stay unresolved
// even after refresh changes their task status to failed/completed. Never backfill facts.
function hasUnresolvedDelivery(run) {
  if (run.delivery === 'unknown') return true
  if (run.delivery === 'delivered' || run.delivery === 'not-delivered') return false
  return typeof run.messageId !== 'string' || !run.messageId.trim()
}
function isStageChat(run, role, chat) {
  const marker = new RegExp(`(?:^|[^a-zA-Z0-9_-])Flow ${run.id}(?=$|[\\s:：])`)
  return marker.test(chat.title) && (role === 'product' || chat.title.includes(`[Flow ${role}]`))
}
export default function activate(orca) { return createFlowWorker(orca) }

/** Single trusted worker owns all writes; panel and Bot output cannot write completion state. */
export async function createFlowWorker(orca, { cli = createNativeCli(), dataDir = join(homedir(), '.orca', 'flow-native', 'requests') } = {}) {
  let state = { ...emptyState(), ...await orca.storage.get(STORAGE) }
  // An interrupted send may already have reached a bot. Never silently resend after reload.
  state = { ...state, runs: state.runs.map((run) => run.status === 'sending' ? event({ ...run, status: 'unknown', delivery: 'unknown', error: '插件在发送消息时重新加载，发送结果未确认，请先核对 Orca 执行记录，避免重复发送。' }, 'delivery-unknown', '重新加载时发送结果未确认，请先核对，避免重复发送。') : run) }
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
  const updateRun = (run, items = state.items) => save({ ...state, items, runs: state.runs.map((entry) => entry.id === run.id ? run : entry) })
  const ownedRun = (params) => {
    const run = state.runs.find((entry) => entry.id === id(params.id))
    if (!run || run.target.id !== params.workspaceId) throw invalid('执行记录不存在或不属于当前工作区。')
    if (run.archived) throw invalid('已归档执行记录不可更改或重新执行，请查看原始记录。')
    return run
  }
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
    if (params.kind === 'items' && existing?.status === 'completed' && entity.status !== 'completed' && state.runs.some((run) => run.itemId === entity.id && run.target.id === entity.workspaceId && run.acceptedAt)) throw invalid('已验收任务不能直接重新打开；本插件不提供隐式重启或替代执行记录。')
    if (params.kind === 'items' && entity.status === 'completed' && existing?.status !== 'completed' && state.runs.some((run) => run.itemId === entity.id && run.target.id === entity.workspaceId)) throw invalid('关联执行记录的任务必须通过执行记录内显式验收完成。')
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
    if (params.kind === 'items' && state.runs.some((run) => run.itemId === item.id && run.target.id === item.workspaceId)) throw invalid('任务已有执行记录，暂不能删除；请保留任务关联与验收记录。')
    if (params.kind === 'items' && state.prepared.some((entry) => entry.itemId === item.id && entry.target.id === item.workspaceId)) throw invalid('任务已有准备任务说明，请保留任务关联与任务说明原文。')
    if (['sprints', 'epics'].includes(params.kind) && state.items.some((entry) => entry.workspaceId === item.workspaceId && entry[params.kind === 'sprints' ? 'sprintId' : 'epicId'] === item.id)) throw invalid('请先移除任务关联，再删除此迭代或史诗。')
    return save({ ...state, [params.kind]: state[params.kind].filter((entry) => entry.id !== item.id) })
  }))
  orca.panels.handle('flow.openBoard', async (params) => {
    object(params, ['workspaceId'])
    await target(params.workspaceId)
    if (!orca.host.has('commands.run') || !orca.host.has('workspace.open')) throw new Error('当前 Orca 版本不支持从插件打开工作区看板，请在 Orca 中手动打开。')
    await orca.host.call('workspace.open', { workspaceId: params.workspaceId })
    const result = await orca.host.call('commands.run', { action: 'workspace.openBoard' })
    if (result?.ran !== true) throw new Error('Orca 未确认打开看板。')
    return { opened: true }
  })
  orca.panels.handle('flow.findStageChats', async (params) => {
    object(params, ['id', 'workspaceId', 'role'])
    const run = state.runs.find((entry) => entry.id === id(params.id) && entry.target.id === params.workspaceId)
    if (!run || !ROLE_KEYS.includes(params.role)) throw invalid('执行记录、工作区或角色无效。')
    const botId = id(run.roles[params.role])
    const result = await cli.listBotChats(botId)
    // Titles are a search aid, never authoritative task/session bindings.
    const matches = result.chats.filter((chat) => isStageChat(run, params.role, chat))
    return { botId, botName: result.botName, match: 'title-candidates', canFocus: orca.host.has?.('agent.focus') === true, truncated: matches.length > 20,
      chats: matches.slice(0, 20).map((chat) => ({ ...chat, title: truncateUtf8(chat.title, 1000) })) }
  })
  orca.panels.handle('flow.focusStageChat', async (params) => {
    object(params, ['id', 'workspaceId', 'role', 'sessionId'])
    const run = state.runs.find((entry) => entry.id === id(params.id) && entry.target.id === params.workspaceId)
    if (!run || !ROLE_KEYS.includes(params.role)) throw invalid('执行记录、工作区或角色无效。')
    const sessionId = id(params.sessionId)
    if (orca.host.has?.('agent.focus') !== true) throw invalid('当前 Orca 不支持打开已有聊天，请使用聊天列表中的手动查找路径。')
    const result = await cli.listBotChats(id(run.roles[params.role]))
    const matches = result.chats.filter((chat) => chat.id === sessionId)
    if (matches.length !== 1 || matches[0].closed || !isStageChat(run, params.role, matches[0])) throw invalid('聊天已关闭、归属不匹配或关联标记已变化，请重新查找；不会恢复或创建替代会话。')
    const answer = await orca.host.call('agent.focus', { sessionId, hostId: 'local' })
    if (answer?.focused !== true) throw invalid('Orca 未确认定位到聊天；不会自动重试，请核对当前界面。')
    return { focused: true }
  })
  // No trusted-worker sender/delegation API exists in the supported Orca build.
  // Reject even legacy IDs and injected mock senders: there is no delivery escape hatch.
  orca.panels.handle('flow.launch', async () => {
    throw invalid('当前版本不支持由插件向机器人发送消息。请先准备任务说明，再在对应机器人的聊天中手动提交；插件不会发送消息或启动任务。')
  })
  orca.panels.handle('flow.prepare', (params) => serial(async () => {
    object(params, ['id', 'title', 'goal', 'workspaceId', 'itemId', 'acceptance', 'scope', 'mode', 'requiresIndependentReview'])
    const request = { id: id(params.id), title: text(params.title, '目标名称', 160), goal: text(params.goal, '任务目标', 50000), workspaceId: text(params.workspaceId, '目标工作区', 500),
      mode: params.mode === undefined ? 'quick' : text(params.mode, '执行路线', 20),
      requiresIndependentReview: params.requiresIndependentReview === undefined ? false : params.requiresIndependentReview,
      ...(params.itemId !== undefined ? { itemId: id(params.itemId) } : {}),
      ...(params.acceptance !== undefined ? { acceptance: text(params.acceptance, '验收标准', 12000) } : {}),
      scope: params.scope === undefined || params.scope === '' ? DEFAULT_SCOPE : text(params.scope, '只读盘点/允许修改范围', 12000) }
    const draftPlan = resolveExecutionPlan(request.mode, {}, request.requiresIndependentReview)
    const sameContent = (entry) => JSON.stringify({ ...entry.request, id: '' }) === JSON.stringify({ ...request, id: '' })
    const previous = state.prepared.find((entry) => entry.id === request.id)
    if (previous) {
      if (!sameContent(previous)) throw invalid('相同准备 ID 的内容、工作区或本次执行路线已变化，拒绝覆盖。')
      return state
    }
    if (state.runs.some((run) => run.id === request.id)) throw invalid('此 ID 已属于已有执行记录，不能改为准备记录。')
    const item = request.itemId ? state.items.find((entry) => entry.id === request.itemId && entry.workspaceId === request.workspaceId) : null
    if (request.itemId && (!item || !request.acceptance)) throw invalid('任务必须属于当前工作区，且明确填写验收标准。')
    if (item && state.runs.some((run) => run.itemId === item.id && run.target.id === item.workspaceId)) throw invalid('任务已有执行记录，请先核对原记录，避免重复执行；生成任务说明不会取消原执行。')
    const active = state.runs.find((run) => run.target.id === request.workspaceId && (hasUnresolvedDelivery(run) || !['completed', 'failed'].includes(run.status)))
    if (active) throw invalid(`工作区已有进行中或待核对的执行 ${active.id}，请先核对原记录，避免重复发送或执行；生成任务说明不会取消原执行。`)
    const duplicate = state.prepared.find(sameContent)
    if (duplicate) return state
    if (item && state.prepared.some((entry) => entry.itemId === item.id && entry.target.id === item.workspaceId)) throw invalid('任务已有不同内容的准备任务说明；请查看已保存的任务说明原文，不覆盖或重复创建。')
    const resolved = await target(request.workspaceId)
    const bots = await cli.listBots()
    const roles = validateRoles(state.roles, bots, draftPlan.requiredRoles)
    const product = bots.find((bot) => bot.id === roles.product)
    const productBot = { id: product.id, name: text(product.name, '产品 Bot 名称', 200) }
    const prepared = { id: request.id, request, title: request.title, goal: request.goal, target: resolved, roles,
      productBot, executionPlan: resolveExecutionPlan(request.mode, roles, request.requiresIndependentReview),
      status: 'prepared', createdAt: Date.now(), scope: request.scope,
      ...(item ? { itemId: item.id, itemSnapshot: { ...item } } : {}),
      ...(request.acceptance ? { acceptance: request.acceptance } : {}) }
    const record = { ...prepared, contract: buildKickoff(prepared), contractFile: join(dataDir, `prepared-${prepared.id}.md`) }
    const next = { ...state, prepared: [record, ...state.prepared] }
    checkPreparedCapacity(next)
    await persistContract(dataDir, record)
    return save(next)
  }))
  orca.panels.handle('flow.archiveRun', (params) => serial(async () => {
    object(params, ['id'])
    const run = state.runs.find((entry) => entry.id === id(params.id))
    if (!run || hasUnresolvedDelivery(run) || !['completed', 'failed'].includes(run.status)) throw invalid('只能归档已结束且发送结果已确认的执行。若发送结果未确认，请先核对，避免重复发送；归档不能代替核对。')
    if (run.archived) return state
    if (run.itemId && run.status === 'completed' && !run.acceptedAt) throw invalid('任务尚待显式验收，请先验收再归档。')
    await mkdir(dataDir, { recursive: true })
    const archiveFile = join(dataDir, `${run.id}.archive.json`)
    await writeFile(archiveFile, JSON.stringify(run, null, 2), { encoding: 'utf8', flag: 'wx' })
    return updateRun(event({ ...run, archived: true, archiveFile, goal: '', tasks: run.tasks.map((task) => ({ ...task, result: truncateUtf8(task.result, 256) })) }, 'archived', '用户归档原始目标与证据；不可重新执行。'))
  }))
  orca.panels.handle('flow.refreshRun', (params) => serial(async () => {
    object(params, ['id', 'nativeRunId'])
    const run = state.runs.find((entry) => entry.id === id(params.id))
    if (!run) throw invalid('流程不存在。')
    if (run.archived) throw invalid('已归档执行记录不可重新核实或重新执行。')
    if (run.nativeRunId && params.nativeRunId && run.nativeRunId !== params.nativeRunId) throw invalid('已关联的 Orca 执行记录 ID 不可替换，请核对原记录。')
    const currentTarget = await target(run.target.id)
    if (currentTarget.path !== run.target.path || (currentTarget.branch ?? null) !== (run.target.branch ?? null) || (currentTarget.projectId ?? null) !== (run.target.projectId ?? null) || (currentTarget.hostId ?? null) !== (run.target.hostId ?? null)) throw invalid('目标路径、分支或项目已变化，请人工核对后再继续。')
    const prefix = `Flow ${run.id}: `
    const exactId = run.nativeRunId || params.nativeRunId
    const candidates = exactId ? [{ id: id(exactId) }] : (await cli.listRuns()).filter((entry) => typeof entry.objective === 'string' && entry.objective.startsWith(prefix))
    if (candidates.length !== 1) throw invalid(candidates.length ? '找到多条对应的 Orca 执行记录，请填写准确的执行记录 ID 核对。' : '尚未找到 Orca 执行记录；产品 Bot 可能还未创建任务，也可填写准确的执行记录 ID。')
    const info = await cli.getRun(candidates[0].id)
    if (typeof info.objective !== 'string' || !info.objective.startsWith(prefix)) throw invalid('Orca 执行记录的关联标记不匹配。')
    const tasks = await cli.listTasks(candidates[0].id)
    const summary = summarizeTasks(tasks, run.executionPlan)
    const relevant = tasks.filter((task) => STAGES.includes(task.title) || /^\[Flow rework \d+\]$/.test(task.title)).slice(0, 20)
    const evidenceBudget = Math.floor(24 * 1024 / Math.max(1, relevant.length))
    const summaries = relevant.map((task) => ({
      id: id(task.id), title: task.title, status: truncateUtf8(task.status, 100),
      deps: Array.isArray(task.deps) ? task.deps.slice(0, 4).map((dependency) => truncateUtf8(dependency, 120)) : null,
      result: truncateUtf8(task.result, evidenceBudget)
    }))
    const next = observed(run, { ...run, nativeRunId: candidates[0].id, status: summary.status, message: summary.message, tasks: summaries, checkedAt: Date.now() })
    const items = summary.status === 'completed' && run.itemId && !run.acceptedAt ? state.items.map((item) => item.id === run.itemId && item.workspaceId === run.target.id ? { ...item, status: 'in-review' } : item) : state.items
    return updateRun(next, items)
  }))
  orca.panels.handle('flow.linkRun', (params) => serial(async () => {
    object(params, ['id', 'itemId', 'workspaceId', 'confirm'])
    const run = ownedRun(params)
    if (params.confirm !== true) throw invalid('人工关联必须明确确认；不会按标题猜测。')
    const item = state.items.find((entry) => entry.id === id(params.itemId) && entry.workspaceId === run.target.id)
    if (!item) throw invalid('任务不属于执行记录的同一工作区。')
    if (run.itemId && run.itemId !== item.id) throw invalid('执行记录已有任务关联，不可替换。')
    if (run.itemId === item.id) return state
    if (state.runs.some((entry) => entry.id !== run.id && entry.itemId === item.id && entry.target.id === run.target.id)) throw invalid('任务已有执行记录，请先核对已有执行记录。')
    const items = run.checkedAt && !run.acceptedAt && summarizeTasks(run.tasks, run.executionPlan).status === 'completed' && item.status !== 'completed' ? state.items.map((entry) => entry.id === item.id ? { ...entry, status: 'in-review' } : entry) : state.items
    return updateRun(event({ ...run, itemId: item.id }, 'linked', `用户明确关联同工作区任务：${item.id}`), items)
  }))
  orca.panels.handle('flow.acceptRun', (params) => serial(async () => {
    object(params, ['id', 'workspaceId', 'confirm'])
    const run = ownedRun(params)
    if (params.confirm !== true) throw invalid('验收必须由用户明确确认。')
    if (run.acceptedAt) return state
    if (!run.itemId || !run.checkedAt || summarizeTasks(run.tasks, run.executionPlan).status !== 'completed') throw invalid('需关联任务，且核实本次执行路线依赖与完整结果证据后才能验收。')
    const item = state.items.find((entry) => entry.id === run.itemId && entry.workspaceId === run.target.id)
    if (!item) throw invalid('关联任务不存在或工作区不匹配。')
    return updateRun(event({ ...run, acceptedAt: Date.now() }, 'accepted', `用户明确验收任务：${item.id}`), state.items.map((entry) => entry.id === item.id ? { ...entry, status: 'completed' } : entry))
  }))
  await save(state)
}
