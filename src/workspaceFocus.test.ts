import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const workspaces = [
  { id: 'ws-a', name: 'dev', path: 'E:/work/app-one', branch: 'dev', projectId: 'repo-a', hostId: 'local' },
  { id: 'ws-b', name: 'dev', path: 'D:/work/app-two', branch: 'dev', projectId: 'repo-b', hostId: 'local' }
]
const state = { roles: {}, bots: [], items: [], epics: [], sprints: [], workflows: [], runs: [], workspaces }
const context = (workspaceId: string) => ({ workspaceId, branch: 'dev', displayName: 'dev', terminals: [] })
function offlineHost(initial: ReturnType<typeof context> | null = context('ws-b')) {
  return mockHost({ results: { 'workspace.readContext': initial }, requests: { 'flow.getState': state } })
}

test('初始定位当前项目，随后按workspace.changed跨项目自动跟随', async () => {
  const view = await mount(panel, { host: offlineHost() })
  try {
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-b')
    assert.equal(view.valueOf({ type: 'Checkbox', label: '自动跟随当前工作区' }), true)
    await view.emit('workspace.changed', { context: context('ws-a') })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-a')
    assert.ok(view.find({ type: 'Text', text: 'E:/work/app-one' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('手动选择固定目标，后续焦点切换不覆盖；重新勾选恢复定位', async () => {
  const view = await mount(panel, { host: offlineHost() })
  try {
    await view.select({ type: 'Select', label: '目标工作区' }, 'ws-a')
    assert.equal(view.valueOf({ type: 'Checkbox', label: '自动跟随当前工作区' }), false)
    await view.emit('workspace.changed', { context: context('ws-b') })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-a')
    await view.toggle({ type: 'Checkbox', label: '自动跟随当前工作区' })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-b')
  } finally { await view.unmount() }
})

test('无当前工作区时保持未定位，不默认选中另一个项目', async () => {
  const view = await mount(panel, { host: offlineHost(null) })
  try {
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), '__none__')
    assert.ok(view.find({ type: 'Button', text: '新建任务' })?.disabled)
    await view.emit('workspace.changed', { context: context('ws-a') })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-a')
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), '__none__')
  } finally { await view.unmount() }
})

test('编辑草稿时焦点切换只暂停跟随，不改写草稿的目标', async () => {
  const view = await mount(panel, { host: offlineHost() })
  try {
    await view.press({ type: 'Button', text: '新建任务' })
    await view.type({ type: 'Input', label: '名称' }, '未提交草稿')
    await view.emit('workspace.changed', { context: context('ws-a') })
    assert.equal(view.valueOf({ type: 'Select', label: '目标工作区' }), 'ws-b')
    assert.equal(view.valueOf({ type: 'Input', label: '名称' }), '未提交草稿')
    assert.equal(view.find({ type: 'Checkbox', label: '自动跟随当前工作区' })?.props.checked, false)
    assert.ok(view.find({ type: 'Text', text: /未提交.*固定/ }) || view.find({ type: 'Callout', text: /未提交.*固定/ }))
  } finally { await view.unmount() }
})
