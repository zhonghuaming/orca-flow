import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const state = { roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [], workspaces: [{ id: 'ws-test', name: '离线测试工作区', path: 'E:/workspace/fixture', branch: 'main' }] }
test('阶段卡可查找已有聊天，清楚说明不能直达；跨工作区清理结果，不发送或重跑', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const run = { id: 'chat-run', title: '盘点', goal: '', target: state.workspaces[0]!, roles, status: 'failed', tasks: [], createdAt: 1 }
  const other = { ...state.workspaces[0]!, id: 'other', path: 'D:/other' }
  let input: unknown
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': { ...state, runs: [run], workspaces: [...state.workspaces, other] },
    'flow.findStageChats': (params) => { input = params; return { botId: 'a', botName: '架构 Bot', match: 'title-candidates' as const, truncated: false, chats: [{ id: 'chat-a', title: 'Flow chat-run [Flow architect] 方案', closed: false }] } }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'runs')
    await view.press({ type: 'Button', text: '查找架构会话' })
    assert.deepEqual(input, { id: 'chat-run', workspaceId: 'ws-test', role: 'architect' })
    assert.ok(view.find({ type: 'Callout', text: /不支持直达 Bot 聊天.*仅按标题查找/ }))
    assert.ok(view.find({ type: 'Text', text: /查找路径：.*架构 Bot/ }))
    assert.ok(view.find({ type: 'Text', text: /会话 ID：.*chat-a/ }))
    assert.equal(view.find({ type: 'Button', text: '打开对应会话' }), null)
    await view.select({ type: 'Select', label: '目标工作区' }, 'other')
    assert.equal(view.find({ type: 'Text', text: /会话 ID：.*chat-a/ }), null)
    assert.equal(h.calls.some((call) => /flow.launch|agent.resume|agent.launch|terminal.send/.test(JSON.stringify(call.params ?? null))), false)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('增强宿主给候选提供打开此聊天入口，只提交所选会话ID且不重跑', async () => {
  const run = { id: 'focus-run', title: '盘点', goal: '', target: state.workspaces[0]!, roles: { product: 'p', architect: 'a', developer: 'd', tester: 't' }, status: 'failed', tasks: [], createdAt: 1 }
  let focused: unknown
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': { ...state, runs: [run] },
    'flow.findStageChats': { botId: 'a', botName: '架构 Bot', match: 'title-candidates' as const, canFocus: true, truncated: false, chats: [{ id: 'chat-a', title: 'Flow focus-run [Flow architect] 方案', closed: false }] },
    'flow.focusStageChat': (params) => { focused = params; return { focused: true as const } }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.select({ type: 'Tabs' }, 'runs')
    await view.press({ type: 'Button', text: '查找架构会话' })
    assert.ok(view.find({ type: 'Callout', text: /可打开下列已有聊天.*仅按标题查找/ }))
    await view.press({ type: 'Button', text: '打开此聊天' })
    assert.deepEqual(focused, { id: run.id, workspaceId: 'ws-test', role: 'architect', sessionId: 'chat-a' })
    assert.ok(view.find({ type: 'Callout', text: /已定位到已有聊天/ }))
    assert.equal(h.calls.some((call) => /flow.launch|agent.resume|agent.launch|terminal.send/.test(JSON.stringify(call.params ?? null))), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('会话查询晚失败不能污染已切换的工作区', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const run = { id: 'late-run', title: '盘点', goal: '', target: state.workspaces[0]!, roles, status: 'failed', tasks: [], createdAt: 1 }
  const other = { ...state.workspaces[0]!, id: 'other', path: 'D:/other' }
  let rejectRead!: (error: Error) => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const pendingRead = new Promise<never>((_resolve, reject) => { rejectRead = reject })
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': { ...state, runs: [run], workspaces: [...state.workspaces, other] },
    'flow.findStageChats': () => { markStarted(); return pendingRead }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.select({ type: 'Tabs' }, 'runs')
    const query = view.press({ type: 'Button', text: '查找架构会话' })
    await started
    const switching = view.select({ type: 'Select', label: '目标工作区' }, 'other')
    rejectRead(new Error('OLD_CONTEXT_READ_ERROR'))
    await Promise.all([query, switching])
    await view.settled()
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'other')
    assert.equal(view.find({ type: 'Callout', text: /OLD_CONTEXT_READ_ERROR/ }), null)
  } finally { await view.unmount() }
})

test('同一任务跨看板工作流记录往返保持精确Run；切工作区不泄漏旧选择', async () => {
  const item = { id: 'item-one', title: '当前任务', description: '验收原文', workspaceId: 'ws-test', status: 'in-progress' }
  const run = { id: 'flow-one', itemId: item.id, title: item.title, goal: '目标', target: state.workspaces[0], roles: { product: 'p', architect: 'a', developer: 'd', tester: 't' }, status: 'blocked', tasks: [{ id: 'task-p', title: '[Flow product]', status: 'blocked', deps: [], result: '离线原始阻塞' }], createdAt: 1, error: 'raw offline error', messageId: 'receipt-one', nativeRunId: 'native-one' }
  const other = { ...state.workspaces[0], id: 'ws-other', name: '另一个', path: 'D:/other' }
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '离线测试工作区', terminals: [] } }, requests: { 'flow.getState': { ...state, items: [item], runs: [run, { id: 'old-unlinked', title: '旧独立运行', goal: '旧目标', target: state.workspaces[0], roles: run.roles, status: 'failed', tasks: [], createdAt: 1 }], workspaces: [...state.workspaces, other] } } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'board')
    assert.ok(view.find({ type: 'Badge', text: '任务：进行中' }))
    assert.ok(view.find({ type: 'Badge', text: '最近执行：阻塞' }))
    await view.press({ type: 'Button', text: '查看阻塞原因' })
    assert.ok(view.find({ type: 'Text', text: /当前执行记录：\s*flow-one/ }))
    assert.ok(view.find({ type: 'Text', text: /下一步：.*人工/ }))
    assert.equal(view.find({ type: 'Button', text: '发送给产品 Bot' }), null)
    assert.ok(view.find({ type: 'Callout', text: /离线原始阻塞/ }))
    assert.ok(view.find({ type: 'Text', text: /Orca 执行记录 ID：\s*native-one/ }))
    assert.ok(view.find({ type: 'Callout', text: /raw offline error/ }))
    await view.press({ type: 'Button', text: '查看本次团队工作流' })
    assert.ok(view.find({ type: 'Text', text: /当前执行记录：\s*flow-one/ }))
    await view.press({ type: 'Button', text: '返回对应看板任务' })
    assert.ok(view.find({ type: 'Text', text: /当前任务：\s*item-one/ }))
    await view.select({ type: 'Select', label: '目标工作区' }, 'ws-other')
    await view.select({ type: 'Tabs' }, 'runs')
    assert.equal(view.find({ type: 'Text', text: /Orca 执行记录 ID：\s*native-one/ }), null)
    assert.equal(view.find({ type: 'EmptyState' })?.props.title, '当前工作区暂无执行记录')
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('待办卡显示最新失败的实际阶段并直达对应记录，不重发', async () => {
  const item = { id: 'inventory', title: '前端盘点', description: '', workspaceId: 'ws-test', status: 'todo' }
  const base = { title: item.title, itemId: item.id, goal: '', target: state.workspaces[0]!, roles: { product: 'p', architect: 'a', developer: 'd', tester: 't' }, tasks: [] }
  const runs = [{ ...base, id: 'older', status: 'completed', createdAt: 1 }, { ...base, id: 'latest', createdAt: 2, status: 'failed', messageId: 'receipt', tasks: ['product','architect','developer','tester'].map((role, i) => ({ id: role, title: `[Flow ${role}]`, status: ['completed','completed','failed','blocked'][i]!, result: i === 2 ? '预览检查失败' : '记录', deps: [] })) }]
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: item.workspaceId, branch: 'main', displayName: '测试', terminals: [] } }, requests: { 'flow.getState': { ...state, items: [item], runs } } })
  const view = await mount(panel, { host: h })
  try {
    assert.ok(view.find({ type: 'Badge', text: '任务：待办' }))
    assert.ok(view.find({ type: 'Badge', text: '最近执行：失败' }))
    assert.ok(view.find({ type: 'Text', text: '产品：已完成；架构：已完成；开发：失败；测试：阻塞' }))
    await view.press({ type: 'Button', text: '查看失败原因' })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'runs')
    assert.ok(view.find({ type: 'Text', text: /当前执行记录：\s*latest/ }))
    assert.ok(view.find({ type: 'Callout', text: /预览检查失败/ }))
    assert.ok(view.find({ type: 'Text', text: /发给产品 Bot 的启动消息：.*有平台回执/ }))
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
  } finally { await view.unmount() }
})

test('准备合同冻结目标与产品Bot，明确prepared不等于sent并给出官方聊天手动步骤；切工作区不泄漏', async () => {
  const item = { id: 'launch-item', title: '准备任务', description: '保留验收原文', workspaceId: 'ws-test', status: 'todo' }
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const bots = Object.values(roles).map((id) => ({ id, name: `官方机器人-${id}`, agent: 'fixture', paused: false }))
  const foreign = { ...state.workspaces[0]!, id: 'foreign', path: 'D:/other' }
  let captured: Record<string, unknown> | undefined
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': { ...state, roles, bots, items: [item], workspaces: [...state.workspaces, foreign] },
    'flow.prepare': (input) => { captured = { ...input }; return { ...state, roles, bots, items: [item], workspaces: [...state.workspaces, foreign], prepared: [{ id: input.id, itemId: input.itemId, title: input.title, goal: input.goal, acceptance: input.acceptance, scope: input.scope, target: state.workspaces[0]!, roles, status: 'prepared' as const, productBot: { id: 'p', name: '官方机器人-p' }, contract: '完整合同原文', contractFile: 'E:/fixture/prepared.md', createdAt: 1 }] } }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.press({ type: 'Button', text: '准备此任务' })
    await view.type({ type: 'Textarea', label: '允许操作范围（只读盘点与允许修改的内容）' }, '只读全仓；仅允许修改 src/demo.ts', { replace: true })
    assert.ok(view.find({ type: 'Text', text: /产品 Bot：.*官方机器人-p.*bot:\s*p/ }))
    await view.press({ type: 'Button', text: '准备任务说明' })
    assert.equal(captured?.itemId, item.id)
    assert.equal(captured?.workspaceId, item.workspaceId)
    assert.equal(captured?.acceptance, item.description)
    assert.equal(captured?.scope, '只读全仓；仅允许修改 src/demo.ts')
    assert.ok(view.find({ type: 'Heading', text: '已准备的任务说明（尚未发送）' }))
    assert.ok(view.find({ type: 'Callout', text: /已生成任务说明，尚未发送/ }))
    assert.ok(view.find({ type: 'Text', text: /1[.．].*Orca.*聊天/ }))
    assert.ok(view.find({ type: 'Text', text: /2[.．].*文件.*复制.*完整/ }))
    assert.ok(view.find({ type: 'Text', text: /3[.．].*明确.*提交.*额度/ }))
    assert.ok(view.find({ type: 'Text', text: /不会自动打开指定聊天/ }))
    await view.press({ type: 'Button', text: '查看任务说明原文' })
    assert.ok(view.find({ type: 'Text', text: '完整合同原文' }))
    assert.equal(view.find({ type: 'Button', text: '发送给产品 Bot' }), null)
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
    await view.select({ type: 'Select', label: '目标工作区' }, 'foreign')
    assert.equal(view.find({ type: 'Text', text: '完整合同原文' }), null)
    assert.equal(view.find({ type: 'Text', text: /产品 Bot：.*官方机器人-p.*bot:\s*p/ }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('多个Run按精确ID切换：旧数据不冒认任务，验收必须用户勾选', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const item = { id: 'accept-item', title: '同名任务', description: '验收', workspaceId: 'ws-test', status: 'in-review' }
  const tasks = ['product', 'architect', 'developer', 'tester'].map((role, index, list) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: index ? [list[index - 1]!] : [], result: 'offline proof' }))
  const completed = { id: 'accept-run', itemId: item.id, title: item.title, goal: '目标', target: state.workspaces[0]!, roles, status: 'completed', tasks, checkedAt: 2, createdAt: 1 }
  const legacy = { id: 'legacy-run', title: item.title, goal: '旧目标', target: state.workspaces[0]!, roles, status: 'blocked', tasks: [], createdAt: 1 }
  const snapshot = { ...state, items: [item], runs: [completed, legacy] }
  let accepted = 0
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': snapshot,
    'flow.acceptRun': (input) => { assert.equal(input.id, 'accept-run'); assert.equal(input.confirm, true); accepted++; return { ...snapshot, items: [{ ...item, status: 'completed' }], runs: [{ ...completed, acceptedAt: 3 }, legacy] } }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'runs')
    await view.press({ type: 'Button', text: /同名任务.*legacy-run/ })
    assert.ok(view.find({ type: 'Text', text: /旧记录未保存事件历史/ }))
    await view.press({ type: 'Button', text: '查看原始任务说明' })
    assert.ok(view.find({ type: 'Text', text: /原始任务说明：\s*旧目标/ }))
    assert.equal(view.find({ type: 'Button', text: '返回对应看板任务' }), null)
    assert.ok(view.find({ type: 'Button', text: '确认关联旧执行记录' })?.disabled)
    await view.press({ type: 'Button', text: /同名任务.*accept-run/ })
    await view.press({ type: 'Button', text: '查看本次团队工作流' })
    assert.ok(view.find({ type: 'Button', text: '明确验收此任务' })?.disabled)
    assert.equal(accepted, 0)
    await view.toggle({ type: 'Checkbox', label: '我已复核四阶段证据与验收标准' })
    await view.press({ type: 'Button', text: '明确验收此任务' })
    assert.equal(accepted, 1)
    assert.ok(view.find({ type: 'Badge', text: '已验收' }))
    await view.press({ type: 'Button', text: '查看原始任务说明' })
    assert.ok(view.find({ type: 'Text', text: /原始任务说明：\s*目标/ }))
    await view.press({ type: 'Button', text: '返回对应看板任务' })
    assert.ok(view.find({ type: 'Button', text: '待办' })?.disabled)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('四角色执行计数不把重复阶段当作额外完成；关联关系使用冻结快照', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const tasks = ['product', 'architect', 'developer', 'tester', 'product'].map((role, index) => ({ id: `stage-${index}`, title: `[Flow ${role}]`, status: 'completed', deps: [], result: 'proof' }))
  const run = { id: 'duplicate-run', itemId: 'moved-item', itemSnapshot: { title: '原任务' }, title: '任务', goal: '目标', target: state.workspaces[0]!, roles, status: 'review', tasks, createdAt: 1 }
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: { 'flow.getState': { ...state, items: [{ id: 'moved-item', title: '任务', description: '', workspaceId: 'ws-test', sprintId: 'later-sprint' }], sprints: [{ id: 'later-sprint', title: '事后新增迭代', description: '', workspaceId: 'ws-test' }], runs: [run] } } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Text', text: /执行进度：\s*3\s*\/4/ }))
    assert.equal(view.find({ type: 'Text', text: /迭代：.*事后新增迭代/ }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('重新加载后已有待验收Run仍默认显示当前任务，不退回新建启动', async () => {
  const run = { id: 'pending-acceptance', itemId: 'pending-item', title: '待验收任务', goal: '原始目标', target: state.workspaces[0]!, roles: { product: 'p', architect: 'a', developer: 'd', tester: 't' }, status: 'completed', tasks: [], createdAt: 1 }
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: { 'flow.getState': { ...state, runs: [run] } } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Text', text: /当前执行记录：\s*pending-acceptance/ }))
    assert.equal(view.find({ type: 'Button', text: '准备任务说明草稿' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('prepare拒绝时保留草稿原文与目标，不关闭表单或创建已发送Run', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const item = { id: 'draft-item', title: '草稿', description: '验收原文', workspaceId: 'ws-test', status: 'todo' }
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: {
    'flow.getState': { ...state, roles, bots: Object.values(roles).map((id) => ({ id, name: id, agent: 'fixture', paused: false })), items: [item] },
    'flow.prepare': () => { throw new Error('旧 unknown 占用，不能清除') }
  } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.press({ type: 'Button', text: '准备此任务' })
    await view.type({ type: 'Textarea', label: '目标与验收标准' }, '未提交草稿 $name', { replace: true })
    await view.press({ type: 'Button', text: '准备任务说明' })
    assert.equal(view.valueOf({ type: 'Textarea', label: '目标与验收标准' }), '未提交草稿 $name')
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-test')
    assert.ok(view.find({ type: 'Button', text: '准备任务说明' }))
    assert.ok(view.find({ type: 'Callout', text: /旧 unknown 占用/ }))
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('导航、准备说明与执行详情使用用户措辞，真实ID、用户原文和失败原因保持可见', async () => {
  const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
  const rawError = 'sender IPC 原始失败原因：连接中断'
  const rawGoal = '用户原文：任务合同 Run mutation，不得替换'
  const rawId = 'Run-original-ID'
  const item = { id: 'copy-item', title: '文案任务', description: '验收原文', workspaceId: 'ws-test', status: 'todo' }
  const run = { id: rawId, itemId: 'existing-item', title: '历史任务', goal: rawGoal, target: state.workspaces[0]!, roles, status: 'blocked', tasks: [], createdAt: 1, error: rawError }
  const prepared = { id: 'copy-prepared', itemId: item.id, title: item.title, goal: rawGoal, target: state.workspaces[0]!, roles, status: 'prepared' as const, productBot: { id: 'p', name: '产品机器人' }, scope: '只读盘点', contract: rawGoal, contractFile: 'E:/fixture/prepared-copy.md', createdAt: 1 }
  const h = mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '测试', terminals: [] } }, requests: { 'flow.getState': { ...state, roles, bots: Object.values(roles).map((id) => ({ id, name: id, agent: 'fixture', paused: false })), items: [item], runs: [run], prepared: [prepared] }, 'flow.openBoard': { opened: true } } })
  const view = await mount(panel, { host: h })
  const checkCopy = () => {
    for (const type of ['Tab', 'Button', 'Heading', 'Text', 'Callout', 'Select', 'Input', 'Textarea']) {
      for (const node of view.findAll({ type })) {
        // Dynamic IDs, saved user content and original failure messages are not UI vocabulary.
        const copy = `${node.text || ''} ${node.props.label || ''}`.replaceAll(rawId, '').replaceAll(rawGoal, '').replaceAll(rawError, '')
        assert.equal(/任务合同|工作项|冻结目标|冻结角色|冻结范围|prepared ≠ sent|原生人工处理|\bRun\b|mutation|sender|trusted-worker|\bIPC\b|门禁|不补造|占用/.test(copy), false, copy)
      }
    }
  }
  try {
    await view.settled()
    for (const tab of ['board', 'roadmap', 'bots', 'workflows', 'runs']) { await view.select({ type: 'Tabs' }, tab); checkCopy() }
    assert.ok(view.find({ type: 'Text', text: /当前执行记录：.*Run-original-ID/ }))
    assert.ok(view.find({ type: 'Callout', text: /sender IPC 原始失败原因：连接中断/ }))
    await view.press({ type: 'Button', text: '查看原始任务说明' })
    assert.ok(view.find({ type: 'Text', text: /用户原文：任务合同 Run mutation，不得替换/ }))
    checkCopy()
    await view.press({ type: 'Button', text: '打开工作区看板' })
    assert.ok(view.find({ type: 'Callout', text: /未定位到具体卡片/ }))
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Callout', text: /已生成任务说明，尚未发送/ }))
    assert.ok(view.find({ type: 'Text', text: /不会自动导入执行记录/ }))
    await view.press({ type: 'Button', text: '展开协作规则' })
    checkCopy()
    await view.select({ type: 'Tabs' }, 'board')
    await view.press({ type: 'Button', text: '准备此任务' })
    assert.ok(view.find({ type: 'Button', text: '准备任务说明' }))
    checkCopy()
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

function host() {
  return mockHost({ results: { 'workspace.readContext': { workspaceId: 'ws-test', branch: 'main', displayName: '离线测试工作区', terminals: [] } }, requests: {
    'flow.getState': state,
    'flow.refreshBots': state,
    'flow.saveEntity': (input) => ({ ...state, items: [input.entity] })
  } })
}
test('原生Flow只有中文业务导航，不出现账号/额度/供应商入口', async () => {
  const view = await mount(panel, { host: host() })
  try {
    assert.ok(view.find({ type: 'Heading', text: 'Orca Flow' }))
    for (const label of ['敏捷看板', '路线图', '团队工作流', '机器人', '执行记录']) assert.ok(view.find({ type: 'Tab', label }))
    for (const forbidden of [/Antigravity/, /Google/, /Quota/, /GEMINI_HOME/, /Summon/]) assert.equal(view.find({ text: forbidden }), null)
    await view.press({ type: 'Button', text: '新建任务' })
    assert.ok(view.find({ type: 'Input', label: '名称' }))
    await view.type({ type: 'Input', label: '名称' }, '自定义 English', { replace: true })
    await view.press({ type: 'Button', text: '保存' })
    assert.ok(view.find({ type: 'Card', label: '自定义 English' }))
    assert.equal(view.find({ type: 'Text', text: '自定义 English' }), null)
    for (const tab of ['roadmap', 'workflows', 'bots', 'runs']) await view.select({ type: 'Tabs' }, tab)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('面板使用明确的宽度约束，窄屏栏目不会撑开整页', async () => {
  const view = await mount(panel, { host: host() })
  try {
    const boxes = view.findAll({ type: 'Box' })
    assert.ok(boxes.some((box) => box.props.width === '100%' && box.props.minWidth === 0 && box.props.maxWidth === '100%'))
    assert.ok(boxes.some((box) => box.props.scroll === 'x'))
  } finally { await view.unmount() }
})

test('工作区选项展示项目上下文且选择后路径与任务目标保持一致', async () => {
  const workspaces = [
    { id: 'repo-a', name: 'master', branch: 'master', path: 'E:/work/app-one', projectName: '应用一' },
    { id: 'repo-b', name: 'master', branch: 'master', path: 'D:/work/app-two', projectName: '应用二' }
  ]
  const h = mockHost({ requests: { 'flow.getState': { ...state, workspaces } } })
  const view = await mount(panel, { host: h })
  try {
    const select = view.find({ type: 'Select', label: '目标工作区' })
    assert.ok(select)
    assert.deepEqual(select.props.options, [
      { label: '请选择目标工作区', value: '__none__' },
      { label: '应用一 · master', value: 'repo-a' },
      { label: '应用二 · master', value: 'repo-b' }
    ])
    await view.select({ type: 'Select', label: '目标工作区' }, 'repo-b')
    assert.ok(view.find({ type: 'Text', text: 'D:/work/app-two' }))
    await view.select({ type: 'Tabs' }, 'workflows')
    await view.press({ type: 'Button', text: '准备任务说明草稿' })
    assert.ok(view.find({ type: 'Text', text: /本次执行工作区：\s*master\s*·\s*D:\/work\/app-two/ }), JSON.stringify(view.findAll({ type: 'Text' }).map((entry) => entry.text)))
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
  } finally { await view.unmount() }
})

test('工作流先显示目标与角色确认，不在加载或导航时派发', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  try {
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Button', text: '准备任务说明草稿' }))
    await view.press({ type: 'Button', text: '准备任务说明草稿' })
    assert.ok(view.find({ type: 'Textarea', label: '目标与验收标准' }))
    assert.ok(view.find({ type: 'Button', text: '准备任务说明' })?.disabled)
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
  } finally { await view.unmount() }
})
