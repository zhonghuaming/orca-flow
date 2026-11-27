import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFlowWorker } from '../worker/main.mjs'
import { buildKickoff, resolveExecutionPlan, summarizeTasks, validateRoles } from '../worker/flow-domain.mjs'
import { DEFAULT_SCOPE, EVIDENCE_PREFIX } from '../worker/execution-plan.mjs'
const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
const bots = Object.values(roles).map((id) => ({ id, name: id, paused: false }))
const target = { id: 'ws', name: 'fixture', path: 'E:/fixture', branch: 'main', hostId: 'local' }
const evidence = (sourceVersion = 'content-1', extra = {}) => EVIDENCE_PREFIX + JSON.stringify({ sourceVersion, summary: '修复离线 fixture', checks: ['定向回归 fixture：通过'], ...extra })
function tasks(mode = 'quick', version = 'content-1') {
  return resolveExecutionPlan(mode).requiredStages.map((title, index, stages) => ({ id: title.slice(6, -1), title, status: 'completed', deps: index ? [stages[index - 1].slice(6, -1)] : [], result: evidence(version, mode === 'complex' ? { independentReview: true } : {}) }))
}
function marker(round, version = 'content-2', extra = {}) {
  return { id: `rework-${round}`, title: `[Flow rework ${round}]`, status: 'completed', deps: [], result: evidence(version, { round, kind: 'reproducible-test-failure', developerTaskId: 'developer', verificationTaskId: 'tester', beforeRevision: `content-${round}`, afterRevision: version, reproduction: '定向测试固定输入：失败输出', regression: '相同输入：通过输出', ...extra }) }
}
test('冻结路线：快速两阶段、轻量一阶段、复杂三阶段；缺证据/跳过/精确依赖不冒充完成，legacy仍需四阶段', () => {
  for (const mode of ['normal', 'quick', 'light', 'complex']) {
    const plan = resolveExecutionPlan(mode, roles)
    const stageTasks = tasks(mode)
    assert.equal(summarizeTasks(stageTasks, plan).status, 'completed')
    assert.notEqual(summarizeTasks(stageTasks.slice(1), plan).status, 'completed')
    assert.equal(summarizeTasks(stageTasks.map((task) => ({ ...task, result: '空泛完成' })), plan).status, 'review')
    assert.equal(summarizeTasks(stageTasks.map((task) => ({ ...task, deps: ['unknown'] })), plan).status, 'review')
  }
  assert.equal(summarizeTasks(tasks()).status, 'running')
  assert.equal(summarizeTasks([...tasks(), { id: 'p', title: '[Flow product]', status: 'completed', deps: [], result: 'proof' }], resolveExecutionPlan()).status, 'review')
  assert.equal(summarizeTasks(tasks().map((task) => task.id === 'tester' ? { ...task, result: evidence('different') } : task), resolveExecutionPlan()).status, 'review')
  assert.equal(summarizeTasks(tasks('light').map((task) => ({ ...task, result: evidence('content-1', { requiresIndependentReview: true }) })), resolveExecutionPlan('light')).status, 'review')
  assert.throws(() => resolveExecutionPlan('invented'))
  assert.throws(() => resolveExecutionPlan('light', roles, true), /不能选择/)
  const sensitive = resolveExecutionPlan('quick', roles, true)
  assert.equal(summarizeTasks(tasks(), sensitive).status, 'review')
  assert.equal(summarizeTasks(tasks().map((task) => ({ ...task, result: evidence('content-1', { independentReview: true }) })), sensitive).status, 'completed')
})
test('同Run返工：最多两轮，有复现、状态、原任务及最终版本证据；未知/跨任务/第三轮不得完成', () => {
  const plan = resolveExecutionPlan()
  assert.equal(summarizeTasks([...tasks('quick', 'content-2'), marker(1)], plan).status, 'completed')
  const fixed = [...tasks('quick', 'content-3'), marker(1), marker(2, 'content-3')]
  assert.equal(summarizeTasks(fixed, plan).status, 'completed')
  assert.equal(summarizeTasks([...fixed, marker(3, 'content-4')], plan).status, 'blocked')
  assert.equal(summarizeTasks([...tasks(), { ...marker(1), status: 'ready' }], plan).status, 'running')
  for (const extra of [{ kind: 'unknown-delivery' }, { developerTaskId: 'other-task' }, { reproduction: '' }, { regression: '' }]) assert.equal(summarizeTasks([...tasks('quick', 'content-2'), marker(1, 'content-2', extra)], plan).status, 'review')
  assert.equal(summarizeTasks([...tasks('quick', 'wrong-final'), marker(1)], plan).status, 'review')
  assert.equal(summarizeTasks([...tasks(), marker(2)], plan).status, 'review')
})
test('kickoff只按冻结路线调度；明确只读、复用证据和未知不重放边界', () => {
  const run = { id: 'flow', title: '改按钮', goal: '明确目标', target, roles, scope: '只读，不修改文件', executionPlan: resolveExecutionPlan() }
  const kickoff = buildKickoff(run)
  assert.match(kickoff, /只读，不修改文件/)
  assert.match(kickoff, /task-title 逐字使用：\[Flow developer\]、\[Flow tester\]/)
  assert.match(kickoff, /原测试任务置 pending/)
  assert.match(kickoff, /同一原生 Run/)
  assert.match(kickoff, /未知投递\/授权失败\/额度耗尽/)
  assert.match(kickoff, /FLOW_EVIDENCE_V1/)
  assert.ok(!kickoff.includes('额外返工需另行确认'))
  assert.match(buildKickoff({ ...run, scope: undefined }), /可逆的离线开发/)
  assert.match(buildKickoff({ ...run, executionPlan: undefined }), /产品→架构→开发→测试四阶段/)
  assert.doesNotThrow(() => validateRoles(roles, bots.map((bot) => bot.id === 'a' ? { ...bot, paused: true } : bot), resolveExecutionPlan().requiredRoles))
})
async function fixture(initialRuns = []) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-routes-'))
  let stored = { roles, bots, runs: initialRuns, items: [{ id: 'item', title: '目标', workspaceId: 'ws', status: 'todo' }], sprints: [], epics: [], workflows: [] }
  let sends = 0
  let currentTasks = tasks()
  const handlers = new Map()
  await createFlowWorker({ storage: { get: async () => structuredClone(stored), set: async (_, state) => { stored = structuredClone(state) } }, panels: { handle: (name, fn) => handlers.set(name, fn), post() {} }, host: { call: async () => ({ workspaces: [target] }) } }, { dataDir: dir, cli: { listBots: async () => bots, send: async () => { sends++; return { messageId: 'receipt' } }, listRuns: async () => [{ id: 'native', objective: 'Flow flow: 目标' }], getRun: async () => ({ objective: 'Flow flow: 目标' }), listTasks: async () => currentTasks } })
  return { dir, request: (name, params) => handlers.get(name)(params), sends: () => sends, tasks: (next) => { currentTasks = next }, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
test('已有快速Run核对同Run返工并只按所需阶段验收；launch不再创建运行', async () => {
  const run = { id: 'flow', title: '目标', goal: '明确目标', target, roles, itemId: 'item', acceptance: '按钮可用', scope: DEFAULT_SCOPE, executionPlan: resolveExecutionPlan('quick', roles), status: 'dispatched', delivery: 'delivered', tasks: [] }
  const f = await fixture([run])
  try {
    await assert.rejects(f.request('flow.launch', { id: 'flow' }), /不支持由插件向机器人发送消息/)
    assert.equal(f.sends(), 0)
    f.tasks([...tasks('quick', 'content-2'), marker(1)])
    let state = await f.request('flow.refreshRun', { id: 'flow' })
    assert.equal(state.runs[0].status, 'completed')
    assert.equal(state.runs[0].tasks.length, 3)
    assert.equal(state.items[0].status, 'in-review')
    state = await f.request('flow.acceptRun', { id: 'flow', workspaceId: 'ws', confirm: true })
    assert.equal(state.items[0].status, 'completed')
  } finally { await f.cleanup() }
})
test('failed但delivery未知仍占工作区，不能新请求重放；显式只读范围原样冻结', async () => {
  const f = await fixture([{ id: 'unknown', title: '旧', goal: '旧', target, roles, status: 'failed', delivery: 'unknown', tasks: [] }])
  try {
    await assert.rejects(f.request('flow.launch', { id: 'new', title: '目标', goal: '目标', workspaceId: 'ws' }), /不支持由插件向机器人发送消息/)
    assert.equal(f.sends(), 0)
  } finally { await f.cleanup() }
  const readonly = await fixture()
  try {
    const state = await readonly.request('flow.prepare', { id: 'flow', title: '目标', goal: '盘点', workspaceId: 'ws', mode: 'light', scope: '只读所有文件，禁止修改' })
    assert.equal(state.prepared[0].scope, '只读所有文件，禁止修改')
    assert.equal(state.prepared[0].executionPlan.requiredStages.length, 1)
  } finally { await readonly.cleanup() }
})
