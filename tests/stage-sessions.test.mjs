import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeCli } from '../worker/native-cli.mjs'
import { createFlowWorker } from '../worker/main.mjs'
import { emptyState } from '../worker/flow-domain.mjs'

const run = { id: 'flow-one', title: '任务', target: { id: 'ws-one' }, roles: { architect: 'bot-a', product: 'bot-p' }, tasks: [], status: 'failed' }
async function harness(chats = [], lookupError) {
  const calls = [], handlers = new Map()
  let stored = { ...emptyState(), runs: [run] }
  await createFlowWorker({
    storage: { get: async () => stored, set: async (_key, value) => { stored = structuredClone(value) } },
    panels: { handle: (key, fn) => handlers.set(key, fn), post: () => {} },
    host: { call: async () => { throw new Error('不得导航或调用其他 Host API') } }
  }, { cli: { listBotChats: async (botId) => { calls.push(botId); if (lookupError) throw lookupError; return { botName: '架构机器人', chats } } } })
  const before = structuredClone(stored)
  return { call: (params) => handlers.get('flow.findStageChats')(params), calls, unchanged: () => assert.deepEqual(stored, before) }
}
const request = { id: run.id, workspaceId: run.target.id, role: 'architect' }

test('阶段会话查询只读且仅查冻结角色：标题结果是候选，不是确认关联', async () => {
  const f = await harness([
    { id: 'chat-good', title: '产品: Flow flow-one [Flow architect] 安全方案', closed: false },
    { id: 'chat-other', title: 'Flow flow-one-extra [Flow architect] 其他记录', closed: false },
    { id: 'chat-role', title: 'Flow flow-one [Flow developer] 开发', closed: false },
    { id: 'chat-home', title: 'Home', closed: false }
  ])
  const result = await f.call(request)
  assert.equal(result.botId, 'bot-a')
  assert.equal(result.botName, '架构机器人')
  assert.deepEqual(result.chats.map((chat) => chat.id), ['chat-good'])
  assert.equal(result.match, 'title-candidates')
  assert.deepEqual(f.calls, ['bot-a'])
  f.unchanged()
})
test('拒绝跨工作区、无效角色、外部注入Bot和不存在记录；不调用CLI', async () => {
  const f = await harness()
  for (const params of [{ ...request, workspaceId: 'other' }, { ...request, role: 'owner' }, { ...request, botId: 'foreign' }, { ...request, id: 'absent' }]) await assert.rejects(f.call(params))
  assert.deepEqual(f.calls, [])
  f.unchanged()
})
test('零匹配、多匹配、关闭聊天和读取失败不冒认会话，不更新执行状态', async () => {
  const empty = await harness()
  assert.deepEqual((await empty.call(request)).chats, [])
  const many = await harness(Array.from({ length: 25 }, (_, i) => ({ id: `chat-${i}`, title: `Flow flow-one [Flow architect] ${i}`, closed: i === 0 })))
  const result = await many.call(request)
  assert.equal(result.chats.length, 20)
  assert.equal(result.truncated, true)
  assert.equal(result.chats[0].closed, true)
  const broken = await harness([], new Error('native read failed'))
  await assert.rejects(broken.call(request), /native read failed/)
  empty.unchanged(); many.unchanged(); broken.unchanged()
})
test('原生聊天适配器只运行bot chats，校验形状，不读取消息或执行模型', async () => {
  const calls = []
  const cli = createNativeCli({ exec: async (_exe, args, options) => {
    calls.push(args)
    assert.equal(options.shell, false)
    return { stdout: JSON.stringify({ ok: true, result: { bot: '架构机器人', chats: [{ id: 'chat-a', title: '已有聊天', closed: false, messages: ['不应回传'] }] } }) }
  } })
  assert.deepEqual(await cli.listBotChats('bot-a'), { botName: '架构机器人', chats: [{ id: 'chat-a', title: '已有聊天', closed: false }] })
  assert.deepEqual(calls, [['bot', 'chats', '--environment', 'local', '--bot', 'bot-a', '--all', '--json']])
  const bad = createNativeCli({ exec: async () => ({ stdout: JSON.stringify({ ok: true, result: { bot: 'Bot', chats: [{ id: 'bad', title: null }] } }) }) })
  await assert.rejects(bad.listBotChats('bot-a'), /聊天/)
})
