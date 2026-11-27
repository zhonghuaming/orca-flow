import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFlowWorker } from '../worker/main.mjs'
const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
const bots = Object.values(roles).map((id) => ({ id, name: `官方产品-${id}`, paused: false }))
const target = { id: 'ws', name: '测试', path: 'E:/fixture', branch: 'dev', projectId: 'project', hostId: 'local' }
const item = { id: 'item', title: '原工作项', workspaceId: 'ws', status: 'todo' }
const payload = { id: 'prepare-one', title: '目标', goal: '原文 $name `中文`', workspaceId: 'ws', itemId: 'item', acceptance: '定向验证' }
async function fixture(initial = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-prepare-'))
  let stored = { roles, bots, items: [item], runs: [], ...initial }
  let mutations = 0, failStorage = false
  const handlers = new Map()
  const api = { storage: { get: async () => structuredClone(stored), set: async (_, next) => { if (failStorage) throw new Error('storage failure'); stored = structuredClone(next) } }, panels: { handle: (name, fn) => handlers.set(name, fn), post() {} }, host: { call: async (name) => { assert.equal(name, 'workspace.list'); return { workspaces: [target, { ...target, id: 'foreign', path: 'D:/foreign' }] } } } }
  const cli = { listBots: async () => bots, send: async () => { mutations++; throw new Error('MUTATION') }, ...options.cli }
  const dataDir = options.block ? join(dir, 'blocked') : dir
  if (options.block) await writeFile(dataDir, 'file')
  const load = () => createFlowWorker(api, { cli, dataDir })
  await load()
  return { dir, load, request: (name, input) => handlers.get(name)(input), state: () => structuredClone(stored), mutations: () => mutations, fail: (value) => { failStorage = value }, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
test('prepare仅持久化冻结合同，无send/模型/原生Run/状态推进，重复内容与工作项幂等且重载可恢复', async () => {
  const f = await fixture()
  try {
    const before = f.state()
    const [next, doubleClick] = await Promise.all([f.request('flow.prepare', payload), f.request('flow.prepare', payload)])
    assert.deepEqual(doubleClick, next)
    const prepared = next.prepared[0]
    assert.equal(prepared.status, 'prepared')
    assert.equal(prepared.productBot.name, '官方产品-p')
    assert.equal(prepared.productBot.id, 'p')
    assert.equal(prepared.executionPlan.mode, 'quick')
    assert.match(prepared.contract, /原文 \$name `中文`/)
    assert.equal(await readFile(prepared.contractFile, 'utf8'), prepared.contract)
    assert.deepEqual(next.items, before.items)
    assert.deepEqual(next.runs, before.runs)
    for (const key of ['delivery', 'nativeRunId', 'messageId', 'tasks', 'acceptedAt']) assert.equal(Object.hasOwn(prepared, key), false)
    assert.equal(f.mutations(), 0)
    assert.deepEqual(await f.request('flow.prepare', payload), next)
    assert.deepEqual(await f.request('flow.prepare', { ...payload, id: 'misclick' }), next)
    assert.equal((await readdir(f.dir)).length, 1)
    for (const changed of [{ goal: '变化' }, { mode: 'complex' }, { workspaceId: 'foreign' }, { acceptance: '变化' }, { scope: '只读' }, { requiresIndependentReview: true }]) await assert.rejects(f.request('flow.prepare', { ...payload, ...changed }), /内容|路线|工作区/)
    await f.load()
    assert.deepEqual(f.state().prepared, next.prepared)
    await assert.rejects(f.request('flow.launch', payload), /不支持.*发送|安全拒绝/)
    assert.equal(f.mutations(), 0)
  } finally { await f.cleanup() }
})
test('unknown旧记录原样保留并阻止同workspace/工作项prepare；跨workspace不能关联', async () => {
  const legacy = { id: 'legacy-unknown-example', target, roles, status: 'unknown', delivery: 'unknown', itemId: 'item', goal: '原文', tasks: [], error: '原错', events: [{ kind: 'old' }] }
  const f = await fixture({ runs: [legacy] })
  try {
    await assert.rejects(f.request('flow.prepare', payload), /待核对|已有执行记录/)
    await assert.rejects(f.request('flow.prepare', { ...payload, workspaceId: 'foreign' }), /工作区/)
    await assert.rejects(f.request('flow.launch', payload), /安全拒绝|不支持.*发送/)
    assert.deepEqual(f.state().runs, [legacy])
    assert.deepEqual(f.state().items, [item])
    assert.deepEqual(await readdir(f.dir), [])
    await assert.rejects(f.request('flow.archiveRun', { id: legacy.id }))
    const { itemId, ...independent } = payload
    const other = await f.request('flow.prepare', { ...independent, id: 'other-workspace', workspaceId: 'foreign' })
    assert.equal(other.prepared[0].target.id, 'foreign')
    assert.deepEqual(other.runs, [legacy])
    assert.deepEqual(other.items, [item])
  } finally { await f.cleanup() }
})
test('prepare文件失败/容量拒绝不产生记录、Run或工作项状态变化', async () => {
  for (const options of [{ block: true }, {}]) {
    const f = await fixture({}, options)
    try {
      if (!options.block) for (let i = 0; i < 32; i++) await writeFile(join(f.dir, `prepared-orphan-${i}.md`), '保留')
      const before = f.state()
      await assert.rejects(f.request('flow.prepare', payload))
      assert.deepEqual(f.state(), before)
      assert.equal(f.mutations(), 0)
    } finally { await f.cleanup() }
  }
  const full = await fixture({ prepared: Array.from({ length: 32 }, (_, i) => ({ id: `old-${i}`, request: { ...payload, id: `old-${i}`, goal: `old-${i}` }, target: { ...target, id: 'foreign' } })) })
  try {
    const before = full.state()
    await assert.rejects(full.request('flow.prepare', payload), /容量/)
    assert.deepEqual(full.state(), before)
    assert.deepEqual(await readdir(full.dir), [])
  } finally { await full.cleanup() }
  const f = await fixture({ workflows: [{ description: 'x'.repeat(210000) }] })
  try { const before = f.state(); await assert.rejects(f.request('flow.prepare', { ...payload, goal: '中'.repeat(20000) }), /容量/); assert.deepEqual(f.state(), before); assert.deepEqual(await readdir(f.dir), []) } finally { await f.cleanup() }
})
test('storage失败后同ID重试恢复同一原文文件；文件被替换绝不覆盖', async () => {
  const f = await fixture()
  try {
    const before = f.state()
    f.fail(true)
    await assert.rejects(f.request('flow.prepare', payload), /storage failure/)
    assert.deepEqual(f.state(), before)
    const file = join(f.dir, (await readdir(f.dir))[0])
    const original = await readFile(file, 'utf8')
    f.fail(false)
    await f.load()
    const next = await f.request('flow.prepare', payload)
    assert.equal(next.prepared[0].contract, original)
    assert.equal((await readdir(f.dir)).length, 1)
  } finally { await f.cleanup() }
  const blocked = await fixture()
  try {
    await writeFile(join(blocked.dir, 'prepared-prepare-one.md'), '别人的原文')
    await assert.rejects(blocked.request('flow.prepare', payload), /文件|原文/)
    assert.equal(await readFile(join(blocked.dir, 'prepared-prepare-one.md'), 'utf8'), '别人的原文')
    assert.equal(blocked.state().prepared.length, 0)
  } finally { await blocked.cleanup() }
})

test('failed但投递unknown不能借归档解除占用；prepared不允许删除稳定工作项', async () => {
  const legacy = { id: 'old-failed', target, roles, status: 'failed', delivery: 'unknown', tasks: [] }
  const f = await fixture({ runs: [legacy] })
  try {
    await assert.rejects(f.request('flow.archiveRun', { id: legacy.id }), /发送结果未确认/)
    assert.deepEqual(f.state().runs, [legacy])
    await assert.rejects(f.request('flow.prepare', payload), /待核对/)
  } finally { await f.cleanup() }
  const prepared = await fixture()
  try {
    await prepared.request('flow.prepare', payload)
    await assert.rejects(prepared.request('flow.deleteEntity', { kind: 'items', id: item.id, workspaceId: target.id }), /准备|合同/)
    const before = prepared.state()
    await assert.rejects(prepared.request('flow.prepare', { ...payload, id: 'other-id', goal: '更改目标' }), /不同内容/)
    assert.deepEqual(prepared.state(), before)
  } finally { await prepared.cleanup() }
})

function legacyReadCli(status) {
  const stages = ['product', 'architect', 'developer', 'tester']
  return {
    getRun: async () => ({ objective: 'Flow legacy-unknown: 原合同' }),
    listTasks: async () => stages.map((role, index) => ({ id: role, title: `[Flow ${role}]`, status, deps: index ? [stages[index - 1]] : [], result: '原生只读证据 fixture' }))
  }
}
for (const status of ['failed', 'completed']) {
  test(`legacy unknown缺投递证据核对为${status}后仍占用，不能prepare/archive且不补字段`, async () => {
    for (const deliveryFields of [{}, { messageId: '' }, { messageId: '   ' }, { delivery: 'invalid' }, { delivery: 'unknown' }, { delivery: 'unknown', messageId: 'receipt-conflict' }]) {
      const legacy = { id: 'legacy-unknown', title: '原合同', goal: '旧目标', target, roles, status: 'unknown', tasks: [], ...deliveryFields }
      const f = await fixture({ runs: [legacy] }, { cli: legacyReadCli(status) })
      try {
        await assert.rejects(f.request('flow.prepare', payload), /待核对/)
        const checked = await f.request('flow.refreshRun', { id: legacy.id, nativeRunId: 'native-legacy' })
        assert.equal(checked.runs[0].status, status)
        assert.ok(checked.runs[0].events.length > 0)
        for (const key of ['delivery', 'messageId', 'itemId']) {
          assert.equal(Object.hasOwn(checked.runs[0], key), Object.hasOwn(legacy, key))
          assert.equal(checked.runs[0][key], legacy[key])
        }
        await f.load()
        const before = f.state()
        await assert.rejects(f.request('flow.prepare', payload), /待核对/)
        await assert.rejects(f.request('flow.archiveRun', { id: legacy.id }), /发送结果未确认/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.state().items, [item])
        assert.deepEqual(await readdir(f.dir), [])
        assert.equal(f.mutations(), 0)
      } finally { await f.cleanup() }
    }
  })
  test(`有明确投递分类或可靠回执的legacy核对为${status}后不误锁prepare/archive`, async () => {
    for (const deliveryFields of [{ delivery: 'delivered' }, { delivery: 'not-delivered' }, { messageId: 'platform-receipt' }]) {
      const legacy = { id: 'legacy-unknown', title: '原合同', goal: '旧目标', target, roles, status: 'unknown', tasks: [], ...deliveryFields }
      const f = await fixture({ runs: [legacy] }, { cli: legacyReadCli(status) })
      try {
        await assert.rejects(f.request('flow.prepare', payload), /待核对/)
        const checked = await f.request('flow.refreshRun', { id: legacy.id, nativeRunId: 'native-legacy' })
        assert.equal(checked.runs[0].status, status)
        const prepared = await f.request('flow.prepare', payload)
        assert.equal(prepared.prepared.length, 1)
        const archived = await f.request('flow.archiveRun', { id: legacy.id })
        assert.equal(archived.runs[0].archived, true)
        for (const key of ['delivery', 'messageId', 'itemId']) {
          assert.equal(Object.hasOwn(archived.runs[0], key), Object.hasOwn(legacy, key))
          assert.equal(archived.runs[0][key], legacy[key])
        }
        assert.equal(f.mutations(), 0)
      } finally { await f.cleanup() }
    }
  })
}
