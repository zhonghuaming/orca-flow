import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../worker/flow-domain.mjs').catch(() => ({}))
const native = await import('../worker/native-cli.mjs').catch(() => ({}))
const worker = await import('../worker/main.mjs')
const roles = { product: 'bot-p', architect: 'bot-a', developer: 'bot-d', tester: 'bot-t' }
const bots = Object.values(roles).map((id) => ({ id, name: id, agent: 'test', paused: false }))
const target = { id: 'ws-test', name: 'Test', path: 'E:/workspace/flow-fixture', branch: 'main', hostId: 'local' }
const completeTasks = ['product', 'architect', 'developer', 'tester'].map((role, index, list) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: index ? [list[index - 1]] : [], result: 'offline evidence' }))
const proof = (sourceVersion = 'fixture-content-v1', extra = {}) => 'FLOW_EVIDENCE_V1\n' + JSON.stringify({ sourceVersion, summary: '离线真实 fixture 结果', checks: ['node --test targeted：通过（fixture）'], ...extra })
const quickTasks = ['developer', 'tester'].map((role, index, list) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: index ? [list[index - 1]] : [], result: proof() }))

test('工作项稳定关联与冻结范围：四阶段完成仅待验收，显式确认才完成且不改变迭代', async () => {
  let sends = 0
  const f = await fixture(async () => { sends++; return { messageId: 'receipt' } }, { listTasks: async () => quickTasks })
  try {
    await f.request('flow.saveRoles', { roles })
    await f.request('flow.saveEntity', { kind: 'sprints', entity: { id: 'sprint', title: '迭代', workspaceId: target.id, status: 'active' } })
    const item = { id: 'item', title: '任务', description: '验收说明', workspaceId: target.id, status: 'todo', sprintId: 'sprint' }
    await f.request('flow.saveEntity', { kind: 'items', entity: item })
    const payload = { id: 'flow-test', title: '中文目标', goal: '目标', workspaceId: target.id, itemId: item.id, acceptance: '测试通过', scope: '仅允许修改 src；其余只读盘点' }
    const launched = await f.seedRun(payload)
    assert.equal(launched.runs[0].itemId, 'item')
    assert.equal(launched.runs[0].scope, payload.scope)
    assert.equal(launched.runs[0].acceptance, '测试通过')
    await assert.rejects(f.request('flow.launch', { ...payload, id: 'another' }), /不支持由插件向机器人发送消息/)
    assert.equal(sends, 0)
    await assert.rejects(f.request('flow.launch', { ...payload, scope: '扩张权限' }))
    const checked = await f.request('flow.refreshRun', { id: 'flow-test' })
    assert.equal(checked.items[0].status, 'in-review')
    assert.equal(checked.sprints[0].status, 'active')
    await assert.rejects(f.request('flow.archiveRun', { id: 'flow-test' }), /验收/)
    await assert.rejects(f.request('flow.saveEntity', { kind: 'items', entity: { ...item, status: 'completed' } }), /验收/)
    await assert.rejects(f.request('flow.acceptRun', { id: 'flow-test', workspaceId: target.id, confirm: false }))
    const accepted = await f.request('flow.acceptRun', { id: 'flow-test', workspaceId: target.id, confirm: true })
    assert.equal(accepted.items[0].status, 'completed')
    assert.equal(accepted.runs[0].acceptedAt > 0, true)
    assert.equal(accepted.sprints[0].status, 'active')
    await assert.rejects(f.request('flow.saveEntity', { kind: 'items', entity: { ...item, status: 'todo' } }), /已验收/)
    assert.equal((await f.request('flow.acceptRun', { id: 'flow-test', workspaceId: target.id, confirm: true })).runs[0].events.filter((e) => e.kind === 'accepted').length, 1)
  } finally { await f.cleanup() }
})

test('历史只记录变化且容量有界；阻塞不推断未送达，归档拒绝核实与重放', async () => {
  let status = 'blocked'
  const f = await fixture(undefined, { listTasks: async () => [{ ...quickTasks[0], status, result: 'raw blocker' }] })
  try {
    await f.request('flow.saveRoles', { roles })
    await f.seedRun({ id: 'flow-test', title: '中文目标', goal: '目标', workspaceId: target.id })
    let result = await f.request('flow.refreshRun', { id: 'flow-test' })
    const events = result.runs[0].events
    assert.equal(result.runs[0].status, 'blocked')
    assert.equal(result.runs[0].delivery, 'delivered')
    result = await f.request('flow.refreshRun', { id: 'flow-test' })
    assert.deepEqual(result.runs[0].events, events)
    for (let i = 0; i < 100; i++) { status = i % 2 ? 'blocked' : 'running'; result = await f.request('flow.refreshRun', { id: 'flow-test' }) }
    assert.ok(result.runs[0].events.length <= 40)
    assert.ok(Buffer.byteLength(JSON.stringify(result.runs[0].events)) <= 16 * 1024)
    status = 'failed'
    await f.request('flow.refreshRun', { id: 'flow-test' })
    await f.request('flow.archiveRun', { id: 'flow-test' })
    await assert.rejects(f.request('flow.refreshRun', { id: 'flow-test' }), /归档/)
    await assert.rejects(f.request('flow.launch', { id: 'flow-test', title: '中文目标', goal: '目标', workspaceId: target.id }), /不支持由插件向机器人发送消息/)
    assert.equal(typeof f.request, 'function')
  } finally { await f.cleanup() }
})

test('旧Run不猜标题；仅明确确认同工作区人工关联，不虚构历史或续接能力', async () => {
  const legacy = { id: 'old', title: '同名', goal: '旧目标', target, roles, status: 'blocked', tasks: [] }
  const initial = { roles, bots, items: [{ id: 'item', title: '同名', workspaceId: target.id, status: 'todo' }, { id: 'foreign', title: '同名', workspaceId: 'other', status: 'todo' }], sprints: [], epics: [], workflows: [], runs: [legacy] }
  const f = await fixture(undefined, {}, initial)
  try {
    const before = await f.request('flow.getState')
    assert.equal(before.runs[0].itemId, undefined)
    assert.equal(before.runs[0].events, undefined)
    await assert.rejects(f.request('flow.linkRun', { id: 'old', itemId: 'item', workspaceId: target.id, confirm: false }))
    await assert.rejects(f.request('flow.linkRun', { id: 'old', itemId: 'foreign', workspaceId: target.id, confirm: true }))
    const linked = await f.request('flow.linkRun', { id: 'old', itemId: 'item', workspaceId: target.id, confirm: true })
    assert.equal(linked.runs[0].itemId, 'item')
    assert.deepEqual(linked.runs[0].events.map((e) => e.kind), ['linked'])
    await assert.rejects(f.request('flow.acceptRun', { id: 'old', workspaceId: target.id, confirm: true }))
    await assert.rejects(f.request('flow.deleteEntity', { kind: 'items', id: 'item', workspaceId: target.id }), /执行记录/)
  } finally { await f.cleanup() }
})

test('先核实完成再人工关联旧Run，工作项原子进入待验收', async () => {
  const legacy = { id: 'flow-test', title: '中文目标', goal: '原始验收合同', target, roles, status: 'dispatched', tasks: [] }
  const item = { id: 'legacy-item', title: '任务', workspaceId: target.id, status: 'todo' }
  const initial = { roles, bots, items: [item], sprints: [], epics: [], workflows: [], runs: [legacy] }
  const f = await fixture(undefined, { listTasks: async () => completeTasks }, initial)
  try {
    const checked = await f.request('flow.refreshRun', { id: legacy.id })
    assert.equal(checked.items[0].status, 'todo')
    const linked = await f.request('flow.linkRun', { id: legacy.id, itemId: item.id, workspaceId: target.id, confirm: true })
    assert.equal(linked.items[0].status, 'in-review')
    assert.equal(linked.runs[0].acceptedAt, undefined)
    assert.equal(linked.runs[0].goal, '原始验收合同')
  } finally { await f.cleanup() }
})

test('原生四角色必须唯一、存在且未暂停，不自动替换角色', () => {
  assert.equal(typeof core.validateRoles, 'function')
  assert.deepEqual(core.validateRoles(roles, bots), roles)
  assert.throws(() => core.validateRoles({ ...roles, tester: 'missing' }, bots))
  assert.throws(() => core.validateRoles({ ...roles, tester: roles.developer }, bots))
  assert.throws(() => core.validateRoles(roles, bots.map((b) => ({ ...b, paused: true }))))
})

test('启动正文保留用户目标原文，携带冻结工作区、四角色与原生依赖及验收边界', () => {
  assert.equal(typeof core.buildKickoff, 'function')
  const text = core.buildKickoff({ id: 'flow-test', title: '中文目标', goal: '原样 $name `test`', target, roles })
  assert.ok(text.includes('原样 $name `test`'))
  for (const id of Object.values(roles)) assert.ok(text.includes(id))
  for (const term of ['run-create', 'task-create', 'task-update', 'orchestration send', 'execFileSync', 'JSON.parse', '--body-file', target.path, target.id, 'Flow flow-test']) assert.ok(text.includes(term))
  assert.ok(text.includes('不能将消息投递、终端退出或机器人空闲当作完成'))
})

test('原生任务状态只按四个指定阶段及结果证据计算，不凭空闲或投递成功完成', () => {
  assert.equal(typeof core.summarizeTasks, 'function')
  assert.equal(core.summarizeTasks([]).status, 'waiting')
  const tasks = ['product', 'architect', 'developer', 'tester'].map((role, index, list) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: index ? [list[index - 1]] : [], result: 'evidence.md' }))
  assert.equal(core.summarizeTasks(tasks).status, 'completed')
  assert.equal(core.summarizeTasks(tasks.slice(0, 3)).status, 'running')
  assert.equal(core.summarizeTasks(tasks.map((t) => ({ ...t, result: '' }))).status, 'review')
  assert.equal(core.summarizeTasks([{ ...tasks[0], status: 'failed' }]).status, 'failed')
  assert.equal(core.summarizeTasks([...tasks, tasks[0]]).status, 'review')
})

test('原生CLI不暴露发送适配器，所有只读命令不经shell也不继承会话身份', async () => {
  const calls = []
  const cli = native.createNativeCli({ executable: process.execPath, exec: async (...args) => {
    calls.push(args)
    return { stdout: JSON.stringify({ ok: true, result: { bots: [] } }) }
  } })
  assert.equal(cli.send, undefined)
  await cli.listBots()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].shell, false)
  assert.equal(calls[0][2].env.ORCA_SESSION_ID, undefined)
  assert.equal(calls[0][1].includes('--from'), false)
})

test('CLI 拒绝畸形响应并保留供应商/平台原始错误，不假装成功', async () => {
  assert.equal(typeof native.createNativeCli, 'function')
  for (const stdout of ['bad-json', '{"ok":false,"error":{"message":"Raw platform failure"}}']) {
    const cli = native.createNativeCli({ executable: process.execPath, exec: async () => ({ stdout }) })
    await assert.rejects(cli.listBots())
  }
})

async function fixture(send = async () => ({ messageId: 'msg-test' }), overrides = {}, initialState, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-flow-test-'))
  const store = new Map(initialState ? [['flow_native_v1', initialState]] : [])
  const handlers = new Map()
  const cli = {
    listBots: async () => bots,
    send,
    listRuns: async () => [{ id: 'run-test', objective: 'Flow flow-test: 中文目标' }],
    getRun: async (id) => ({ runId: id, objective: 'Flow flow-test: 中文目标' }),
    listTasks: async () => [],
    ...overrides
  }
  const api = {
    storage: { get: async (k) => structuredClone(store.get(k)), set: async (k, v) => { store.set(k, structuredClone(v)) } },
    host: { has: () => true, call: async (name) => name === 'workspace.list' ? { workspaces: [options.workspace || target] } : { opened: true, ran: true } },
    panels: { handle: (name, fn) => { handlers.set(name, fn) }, post: () => {} },
    commands: { register: () => {} }, events: { on: () => {} }
  }
  assert.equal(typeof worker.createFlowWorker, 'function')
  const dataDir = options.blockDataDir ? join(dir, 'blocked') : dir
  if (options.blockDataDir) await writeFile(dataDir, 'not a directory')
  await worker.createFlowWorker(api, { cli, dataDir })
  // Offline historical data fixture, never a production delivery path.
  async function seedRun(payload) {
    const current = structuredClone(store.get('flow_native_v1'))
    const item = current.items.find((entry) => entry.id === payload.itemId)
    const run = { ...payload, target, roles, executionPlan: core.resolveExecutionPlan('quick', roles), status: 'dispatched', delivery: 'delivered', messageId: 'fixture-old-receipt', tasks: [], createdAt: 1,
      ...(item ? { itemSnapshot: { ...item } } : {}) }
    store.set('flow_native_v1', { ...current, runs: [run, ...current.runs] })
    await worker.createFlowWorker(api, { cli, dataDir })
    return structuredClone(store.get('flow_native_v1'))
  }
  return { dir, store, seedRun, request: (name, value) => handlers.get(name)(value), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('旧launch无条件安全拒绝：有效/重复/旧ID都不能投递或建立运行', async () => {
  let count = 0
  const f = await fixture(async () => { count++; throw new Error('禁止投递') })
  try {
    const before = await f.request('flow.getState')
    for (const value of [{}, { id: 'flow-test', title: '目标', goal: '目标', workspaceId: target.id }]) await assert.rejects(f.request('flow.launch', value), /不支持由插件向机器人发送消息/)
    assert.equal(count, 0)
    assert.deepEqual(await f.request('flow.getState'), before)
  } finally { await f.cleanup() }
})

test('严格校验工作区及IPC，拒绝原型键、未知字段、非法状态且不修改用户文本', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.request('flow.launch', { id: '../x', title: 'x', goal: 'x', workspaceId: 'bad' }))
    await assert.rejects(f.request('flow.saveRoles', JSON.parse('{"roles":{},"__proto__":{}}')))
    await assert.rejects(f.request('flow.saveEntity', { kind: 'items', entity: { id: 'x', title: 'x', status: 'invalid' } }))
    const res = await f.request('flow.saveEntity', { kind: 'items', entity: { id: 'task-test', title: '自定义 English', description: '原样 $x', status: 'todo', workspaceId: target.id } })
    assert.equal(res.items[0].title, '自定义 English')
    assert.equal(res.items[0].description, '原样 $x')
  } finally { await f.cleanup() }
})

test('关联实体不能误删，原生看板只在显式请求后打开', async () => {
  const f = await fixture()
  try {
    const sprint = { id: 'sprint-test', title: '迭代', workspaceId: target.id, status: 'planning' }
    await f.request('flow.saveEntity', { kind: 'sprints', entity: sprint })
    await f.request('flow.saveEntity', { kind: 'sprints', entity: { ...sprint, status: 'active' } })
    await f.request('flow.saveEntity', { kind: 'items', entity: { id: 'task-linked', title: '关联任务', workspaceId: target.id, sprintId: sprint.id, status: 'todo' } })
    await assert.rejects(f.request('flow.deleteEntity', { kind: 'sprints', id: sprint.id, workspaceId: target.id }), /关联/)
    await assert.rejects(f.request('flow.deleteEntity', { kind: 'items', id: 'task-linked', workspaceId: 'other' }))
    await f.request('flow.deleteEntity', { kind: 'items', id: 'task-linked', workspaceId: target.id })
    const state = await f.request('flow.deleteEntity', { kind: 'sprints', id: sprint.id, workspaceId: target.id })
    assert.deepEqual(state.sprints, [])
    assert.equal((await f.request('flow.openBoard', { workspaceId: target.id })).opened, true)
    await assert.rejects(f.request('flow.openBoard', { workspaceId: 'missing' }))
  } finally { await f.cleanup() }
})

test('原生Run关联只接受唯一标记匹配，不消费邮箱；四阶段附证据才完成', async () => {
  const tasks = quickTasks
  const f = await fixture(undefined, { listTasks: async () => tasks })
  try {
    await f.request('flow.refreshBots')
    await f.request('flow.saveRoles', { roles })
    await f.seedRun({ id: 'flow-test', title: '中文目标', goal: '任务', workspaceId: target.id })
    const state = await f.request('flow.refreshRun', { id: 'flow-test' })
    assert.equal(state.runs[0].status, 'completed')
    assert.equal(state.runs[0].nativeRunId, 'run-test')
    await assert.rejects(f.request('flow.refreshRun', { id: 'flow-test', nativeRunId: 'replacement-run' }), /不可替换/)
    await assert.rejects(f.request('flow.refreshRun', { id: 'missing' }))
  } finally { await f.cleanup() }
})

test('Run目标标记不匹配时拒绝关联，不将其他项目结果当成完成', async () => {
  const f = await fixture(undefined, { getRun: async () => ({ objective: 'other' }) })
  try {
    await f.request('flow.refreshBots')
    await f.request('flow.saveRoles', { roles })
    await f.seedRun({ id: 'flow-test', title: '中文目标', goal: '任务', workspaceId: target.id })
    await assert.rejects(f.request('flow.refreshRun', { id: 'flow-test', nativeRunId: 'run-other' }), /标记不匹配/)
  } finally { await f.cleanup() }
})

test('启动中重载恢复unknown并保持不可自动重发', async () => {
  let sent = 0
  const initial = { roles, bots, items: [], sprints: [], epics: [], workflows: [], runs: [{ id: 'flow-test', title: '中文目标', goal: '任务', target, roles, status: 'sending', tasks: [] }] }
  const f = await fixture(async () => { sent++; return { messageId: 'no' } }, {}, initial)
  try {
    const state = await f.request('flow.getState')
    assert.equal(state.runs[0].status, 'unknown')
    await assert.rejects(f.request('flow.launch', { id: 'flow-test', title: '中文目标', goal: '任务', workspaceId: target.id }), /不支持由插件向机器人发送消息/)
    assert.equal(sent, 0)
    await assert.rejects(f.request('flow.launch', { id: 'flow-another', title: '另一个', goal: '任务', workspaceId: target.id }), /不支持由插件向机器人发送消息/)
  } finally { await f.cleanup() }
})

test('连续中文长结果可结算；归档保留原始目标与证据，不占用活动容量', async () => {
  const names = { 'run-test': 'flow-test', 'run-second': 'flow-second' }
  const tasks = quickTasks.map((task) => ({ ...task, result: proof('fixture-content-v1', { summary: '中'.repeat(1200) }) }))
  const f = await fixture(undefined, {
    getRun: async (runId) => ({ objective: `Flow ${names[runId]}: 中文目标` }),
    listTasks: async () => tasks
  })
  try {
    await f.request('flow.saveRoles', { roles })
    await f.seedRun({ id: 'flow-test', title: '中文目标', goal: 'a'.repeat(50000), workspaceId: target.id })
    await f.request('flow.refreshRun', { id: 'flow-test', nativeRunId: 'run-test' })
    await f.seedRun({ id: 'flow-second', title: '中文目标', goal: '第二次', workspaceId: target.id })
    const settled = await f.request('flow.refreshRun', { id: 'flow-second', nativeRunId: 'run-second' })
    assert.equal(settled.runs[0].status, 'completed')
    assert.ok(Buffer.byteLength(JSON.stringify(settled)) < 224 * 1024)
    const archived = await f.request('flow.archiveRun', { id: 'flow-test' })
    assert.equal(archived.runs.find((run) => run.id === 'flow-test').archived, true)
    const raw = JSON.parse(await readFile(join(f.dir, 'flow-test.archive.json'), 'utf8'))
    assert.equal(raw.goal, 'a'.repeat(50000))
    assert.equal(raw.tasks.length, 2)
    assert.ok(Buffer.byteLength(JSON.stringify(archived)) < Buffer.byteLength(JSON.stringify(settled)))
  } finally { await f.cleanup() }
})
