import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const state = { roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [], workspaces: [{ id: 'ws-test', name: '离线测试工作区', path: 'E:/workspace/fixture', branch: 'main' }] }
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
    for (const label of ['敏捷看板', '路线图', '团队工作流', '原生机器人', '运行记录']) assert.ok(view.find({ type: 'Tab', label }))
    for (const forbidden of [/Antigravity/, /Google/, /Quota/, /GEMINI_HOME/, /Summon/]) assert.equal(view.find({ text: forbidden }), null)
    await view.press({ type: 'Button', text: '新建任务' })
    assert.ok(view.find({ type: 'Input', label: '名称' }))
    await view.type({ type: 'Input', label: '名称' }, '自定义 English', { replace: true })
    await view.press({ type: 'Button', text: '保存' })
    assert.ok(view.find({ type: 'Text', text: '自定义 English' }))
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
    await view.press({ type: 'Button', text: '准备启动' })
    assert.ok(view.find({ type: 'Text', text: /冻结工作区：\s*master\s*·\s*D:\/work\/app-two/ }), JSON.stringify(view.findAll({ type: 'Text' }).map((entry) => entry.text)))
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
  } finally { await view.unmount() }
})

test('工作流先显示目标与角色确认，不在加载或导航时派发', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  try {
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Button', text: '准备启动' }))
    await view.press({ type: 'Button', text: '准备启动' })
    assert.ok(view.find({ type: 'Textarea', label: '目标与验收标准' }))
    assert.ok(view.find({ type: 'Button', text: '发送给产品 Bot' })?.disabled)
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
  } finally { await view.unmount() }
})
