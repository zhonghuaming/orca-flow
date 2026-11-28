import { test } from 'node:test'
import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import { createNativeCli, localCliEnvironment, resolveCli } from '../worker/native-cli.mjs'
import { emptyState, invalid, object, summarizeTasks, text, validateEntity } from '../worker/flow-domain.mjs'

test('CLI清除远端/身份/敏感环境，不导出令牌', () => {
  const result = localCliEnvironment({ PATH: 'test', ORCA_SESSION_ID: 'x', ORCA_ENVIRONMENT: 'remote', ORCA_PAIRING_CODE: 'secret', OPENAI_API_KEY: 'secret', SYSTEMROOT: 'sys' })
  assert.equal(result.PATH, 'test')
  assert.equal(result.SYSTEMROOT, 'sys')
  assert.equal(result.ORCA_SESSION_ID, undefined)
  assert.equal(result.ORCA_ENVIRONMENT, undefined)
  assert.equal(result.ORCA_PAIRING_CODE, undefined)
  assert.equal(result.OPENAI_API_KEY, undefined)
  assert.ok(localCliEnvironment({}, 'win32').APPDATA, '精简worker环境必须补齐本机运行元数据目录')
  assert.equal(resolveCli({ ORCA_CLI_COMMAND: 'C:/tools/orca.exe' }, 'win32'), 'C:/tools/orca.exe')
  assert.equal(resolveCli({ LOCALAPPDATA: 'C:/local' }, 'win32').replaceAll('\\', '/'), 'C:/local/Programs/orca/resources/bin/orca.exe')
  assert.equal(resolveCli({}, 'linux'), '/usr/local/bin/orca')
  assert.equal(win32.isAbsolute(resolveCli({}, 'win32')), true, 'Orca worker不提供LOCALAPPDATA时仍须解析绝对CLI路径')
})
test('原生只读JSON接口校验数组形状与参数，绝不查询模型', async () => {
  const calls = []
  const cli = createNativeCli({ executable: process.execPath, exec: async (_exe, args) => {
    calls.push(args)
    const result = args[0] === 'bot' ? { bots: [{ id: 'bot-a', name: '产品', agent: 'test', paused: false }] }
      : args[1] === 'run-list' ? { runs: [] }
      : args[1] === 'task-list' ? { tasks: [] } : { runId: 'run-test' }
    return { stdout: JSON.stringify({ ok: true, result }) }
  } })
  assert.equal((await cli.listBots())[0].name, '产品')
  assert.deepEqual(await cli.listRuns(), [])
  assert.deepEqual(await cli.listTasks('run-test'), [])
  assert.equal((await cli.getRun('run-test')).runId, 'run-test')
  assert.ok(calls.every((args) => args.includes('--environment') && args.includes('local')))
  const bad = createNativeCli({ executable: process.execPath, exec: async () => ({ stdout: '{"ok":true,"result":{}}' }) })
  await assert.rejects(bad.listBots(), /列表格式/)
  await assert.rejects(bad.listRuns(), /列表格式/)
  await assert.rejects(bad.listTasks('run-test'), /列表格式/)
  assert.equal(bad.send, undefined)
})
test('CLI超时错误保留原始平台描述且仅尝试一次', async () => {
  let calls = 0
  const cli = createNativeCli({ exec: async () => { calls++; throw Object.assign(new Error('native timeout'), { stdout: '{"error":{"message":"raw platform error"}}' }) } })
  await assert.rejects(cli.listBots(), /raw platform error/)
  assert.equal(calls, 1)
  const broken = createNativeCli({ exec: async () => { throw new Error('raw timeout') } })
  await assert.rejects(broken.listBots(), /raw timeout/)
})
test('只读CLI完整成功应答后的退出超时保留数据并明确告警，不重试', async () => {
  const warnings = [], calls = []
  const result = { bot: '架构', chats: [{ id: 'chat-a', title: '已有聊天', closed: false }] }
  const cli = createNativeCli({ warn: (line) => warnings.push(line), exec: async (_exe, args) => {
    calls.push(args)
    throw Object.assign(new Error('process cleanup timeout'), { code: null, signal: 'SIGTERM', killed: true, stderr: '', stdout: JSON.stringify({ ok: true, result }) })
  } })
  assert.deepEqual(await cli.listBotChats('bot-a'), { botName: '架构', chats: result.chats })
  assert.equal(calls.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /只读.*未.*结束/)
})
test('不完整应答、平台拒绝、stderr异常和非超时失败不能被当作成功', async () => {
  const good = { code: null, signal: 'SIGTERM', killed: true, stderr: '', stdout: '{"ok":true,"result":{"bot":"架构","chats":[]}}' }
  for (const change of [{ stdout: '{"ok":true' }, { stdout: '{"ok":false,"error":{"message":"native refusal"}}' }, { stderr: 'native failure' }, { killed: false }, { signal: 'SIGKILL' }, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }]) {
    const warnings = []
    const cli = createNativeCli({ warn: (line) => warnings.push(line), exec: async () => { throw Object.assign(new Error('expected native failure'), good, change) } })
    await assert.rejects(cli.listBotChats('bot-a'))
    assert.deepEqual(warnings, [])
  }
})

test('完整成功信封也不能绕过聊天数据形状校验', async () => {
  for (const result of [null, [], {}, { bot: '架构', chats: 'invalid' }, { bot: '架构', chats: [{ id: 'chat-a', title: 'chat', closed: 'false' }] }]) {
    const cli = createNativeCli({ warn: () => {}, exec: async () => {
      throw Object.assign(new Error('timeout'), { code: null, signal: 'SIGTERM', killed: true, stderr: '', stdout: JSON.stringify({ ok: true, result }) })
    } })
    await assert.rejects(cli.listBotChats('bot-a'))
  }
})

test('聊天元数据的退出超时特例不能扩展到任务状态等其他命令', async () => {
  const warnings = []
  const cli = createNativeCli({ warn: (line) => warnings.push(line), exec: async () => {
    throw Object.assign(new Error('timeout'), { code: null, signal: 'SIGTERM', killed: true, stderr: '', stdout: '{"ok":true,"result":{"tasks":[]}}' })
  } })
  await assert.rejects(cli.listTasks('run-test'))
  assert.deepEqual(warnings, [])
})

test('领域校验拒绝未知实体/字段/非法点数与超长文本', () => {
  assert.equal(invalid('test').code, 'invalid_params')
  assert.throws(() => object([], []))
  assert.throws(() => object({ unsafe: 1 }, []))
  assert.throws(() => text('a'.repeat(4), 'x', 3))
  assert.equal(text(undefined, 'x', 3, true), '')
  const base = { id: 'item-test', title: '中文 English', workspaceId: 'ws-test', status: 'todo' }
  assert.throws(() => validateEntity('unknown', base))
  assert.throws(() => validateEntity('items', { ...base, points: -1 }))
  assert.throws(() => validateEntity('items', { ...base, points: 1.5 }))
  assert.throws(() => validateEntity('items', { ...base, points: 1001 }))
  assert.equal(validateEntity('items', { ...base, points: 3 }).points, 3)
  assert.equal(validateEntity('sprints', { ...base, status: 'planning', startDate: '2026-12-01' }).startDate, '2026-12-01')
  assert.deepEqual(emptyState().runs, [])
  assert.equal(summarizeTasks([{ title: '[Flow product]', status: 'blocked' }]).status, 'blocked')
})

test('真实CLI完整字段归一化：task_title与JSON deps，不保留spec', async () => {
  const cli = createNativeCli({ exec: async () => ({ stdout: JSON.stringify({ ok: true, result: { tasks: [{ id: 'task-a', task_title: '[Flow product]', status: 'completed', deps: '[]', result: 'evidence', spec: 'unbounded text' }] } }) }) })
  const tasks = await cli.listTasks('run-test')
  assert.equal(tasks[0].title, '[Flow product]')
  assert.deepEqual(tasks[0].deps, [])
  assert.equal(tasks[0].spec, undefined)
})

test('四阶段全完成但缺依赖或任务ID重复不能视为完整流程', () => {
  const tasks = ['product', 'architect', 'developer', 'tester'].map((role) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: [], result: 'evidence' }))
  assert.equal(summarizeTasks(tasks).status, 'review')
  const chained = tasks.map((task, index) => ({ ...task, deps: index ? [tasks[index - 1].id] : [] }))
  assert.equal(summarizeTasks(chained).status, 'completed')
  assert.equal(summarizeTasks(chained.map((task) => ({ ...task, id: 'same' }))).status, 'review')
})
