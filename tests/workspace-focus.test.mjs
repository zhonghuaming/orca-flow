import { test } from 'node:test'
import assert from 'node:assert/strict'
const focus = await import('../src/workspaceFocus.ts').catch(() => ({}))
const workspaces = [
  { id: 'identity:a', name: 'dev', path: 'E:/work/app-one', branch: 'dev', projectId: 'repo-a', hostId: 'local' },
  { id: 'identity:b', name: 'dev', path: 'D:/work/app-two', branch: 'dev', projectId: 'repo-b', hostId: 'local' }
]

test('按原生工作区精确ID定位，不根据同名分支猜测', () => {
  assert.equal(typeof focus.resolveFocusedWorkspaceId, 'function')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'identity:b', branch: 'dev' }, workspaces), 'identity:b')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'unknown', branch: 'dev' }, workspaces), '')
})
test('原生组合ID映射到列表identity ID，兼容Windows斜线与路径大小写', () => {
  assert.equal(typeof focus.resolveFocusedWorkspaceId, 'function')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'repo-b::d:\\WORK\\APP-TWO' }, workspaces), 'identity:b')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'wrong-repo::D:/work/app-two' }, workspaces), '')
})
test('上下文缺失或别名歧义时清空，不回退到列表第一项', () => {
  assert.equal(typeof focus.resolveFocusedWorkspaceId, 'function')
  assert.equal(focus.resolveFocusedWorkspaceId(null, workspaces), '')
  assert.equal(focus.resolveFocusedWorkspaceId({}, workspaces), '')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'repo-a::E:/work/app-one' }, [...workspaces, { ...workspaces[0], id: 'alias:a' }]), '')
})
test('反序返回的初始快照保留事件更新的工作区与业务记录', async () => {
  assert.equal(typeof focus.mergeInitialSnapshot, 'function')
  const empty = { roles: {}, bots: [], items: [], epics: [], sprints: [], workflows: [], runs: [] }
  const initial = { ...empty, workspaces: [workspaces[0]] }
  let latest = initial
  let release
  const delayedContext = new Promise((resolve) => { release = resolve })
  let contextRevision = 0
  let businessRevision = 0
  const lateInitial = delayedContext.then(() => focus.mergeInitialSnapshot(initial, latest, contextRevision !== 0, businessRevision !== 0))
  // Focus event and business broadcast both arrive before the initial context resolves.
  contextRevision++
  latest = { ...latest, workspaces }
  businessRevision++
  latest = { ...latest, items: [{ id: 'new-task', workspaceId: 'identity:b', title: '较新的任务' }] }
  release()
  const merged = await lateInitial
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'identity:b' }, merged.workspaces), 'identity:b')
  assert.equal(merged.items[0].id, 'new-task')
  assert.equal(initial.items.length, 0)
})

test('无新事件时初始快照正常加载，并保留缺失列表的已有数据', () => {
  assert.equal(typeof focus.mergeInitialSnapshot, 'function')
  const initial = { roles: {}, bots: [], items: [], epics: [], sprints: [], workflows: [], runs: [] }
  const latest = { ...initial, workspaces }
  assert.deepEqual(focus.mergeInitialSnapshot(initial, latest, false, false).workspaces, workspaces)
})

test('POSIX路径大小写敏感，不能定位到不同目录', () => {
  assert.equal(typeof focus.resolveFocusedWorkspaceId, 'function')
  const list = [{ id: 'linux', name: 'main', path: '/work/App', projectId: 'repo', branch: 'main' }]
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'repo::/work/App' }, list), 'linux')
  assert.equal(focus.resolveFocusedWorkspaceId({ workspaceId: 'repo::/work/app' }, list), '')
})
