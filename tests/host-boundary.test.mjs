import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFlowWorker } from '../worker/main.mjs'

const roles = { product: 'bot-p', architect: 'bot-a', developer: 'bot-d', tester: 'bot-t' }
const bots = Object.values(roles).map((id) => ({ id, name: id, paused: false }))
const local = { id: 'ws-test', name: 'test', path: 'E:/workspace/fixture', branch: 'main', hostId: 'local' }
async function harness(workspace = local, blocked = false) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-boundary-'))
  const dataDir = join(dir, 'requests')
  if (blocked) await writeFile(dataDir, 'not a directory')
  let sent = 0
  const store = new Map()
  const handlers = new Map()
  await createFlowWorker({
    storage: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, structuredClone(value)) } },
    panels: { handle: (key, fn) => handlers.set(key, fn), post: () => {} },
    host: { has: () => true, call: async () => ({ workspaces: [workspace] }) }
  }, { dataDir, cli: { listBots: async () => bots, send: async () => { sent++; return { messageId: 'msg-test' } } } })
  return { call: (name, params) => handlers.get(name)(params), sent: () => sent, clean: () => rm(dir, { recursive: true, force: true }) }
}
const launch = { id: 'flow-test', title: 'test', goal: 'test', workspaceId: local.id }
test('拒绝本机Bot处理远端工作区，冻结宿主身份', async () => {
  const f = await harness({ ...local, hostId: 'ssh:remote' })
  try {
    const state = await f.call('flow.getState')
    assert.equal(state.workspaces[0].hostId, 'ssh:remote')
    await f.call('flow.saveRoles', { roles })
    await assert.rejects(f.call('flow.launch', launch), /本机/)
    assert.equal(f.sent(), 0)
  } finally { await f.clean() }
})
test('正文写入前失败明确标记未投递failed，不永久占用工作区', async () => {
  const f = await harness(local, true)
  try {
    await f.call('flow.saveRoles', { roles })
    await assert.rejects(f.call('flow.launch', launch))
    const state = await f.call('flow.getState')
    assert.equal(state.runs[0].status, 'failed')
    assert.equal(f.sent(), 0)
    await assert.rejects(f.call('flow.launch', { ...launch, id: 'flow-another' }), (error) => !error.message.includes('未核实'))
  } finally { await f.clean() }
})
test('拒绝不存在的迭代关联与超出IPC体积的状态', async () => {
  const f = await harness()
  try {
    await assert.rejects(f.call('flow.saveEntity', { kind: 'items', entity: { id: 'task-test', title: 'test', workspaceId: local.id, sprintId: 'missing' } }), /关联/)
    let rejected = false
    for (let index = 0; index < 16; index++) {
      try {
        await f.call('flow.saveEntity', { kind: 'workflows', entity: { id: `wf-${index}`, title: 'test', workspaceId: local.id, description: '中'.repeat(18000), goal: '中'.repeat(18000) } })
      } catch (error) { assert.match(error.message, /容量/); rejected = true; break }
    }
    assert.equal(rejected, true)
  } finally { await f.clean() }
})
