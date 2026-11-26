import { test } from 'node:test'
import assert from 'node:assert/strict'
const labels = await import('../src/workspaceLabels.ts').catch(() => ({}))

const workspace = (changes = {}) => ({ id: 'ws-a', name: 'master', branch: 'master', path: 'E:/workspace/app-one', hostId: 'local', ...changes })

test('项目名称优先，工作区与分支相同时只显示一次', () => {
  assert.equal(typeof labels.buildWorkspaceOptions, 'function')
  const result = labels.buildWorkspaceOptions([workspace({ projectName: '应用一' })])
  assert.equal(result[0].label, '应用一 · master')
  assert.equal(result[0].value, 'ws-a')
})

test('缺失项目名称时使用目录名，Windows/POSIX路径和目录尾斜线均兼容', () => {
  assert.equal(typeof labels.buildWorkspaceOptions, 'function')
  const result = labels.buildWorkspaceOptions([
    workspace(),
    workspace({ id: 'ws-b', path: 'C:\\work\\app-two\\', name: 'main', branch: 'main' }),
    workspace({ id: 'ws-c', path: '/work/app-three/', name: 'main', branch: 'main' })
  ])
  assert.deepEqual(result.map((entry) => entry.label), ['app-one · master', 'app-two · main', 'app-three · main'])
})

test('保留自定义工作区名称与不同分支，无分支文件夹不重复名称', () => {
  assert.equal(typeof labels.buildWorkspaceOptions, 'function')
  const result = labels.buildWorkspaceOptions([
    workspace({ projectName: '应用一', name: '审查工作区', branch: 'feature/review' }),
    workspace({ id: 'folder', path: 'E:/work/脚本', name: '脚本', branch: null })
  ])
  assert.deepEqual(result.map((entry) => entry.label), ['应用一 · 审查工作区 · feature/review', '脚本'])
})

test('同名项目按路径区分，仍完全重名则用工作区ID兜底，不改变目标数据', () => {
  assert.equal(typeof labels.buildWorkspaceOptions, 'function')
  const input = [workspace(), workspace({ id: 'ws-b', path: 'D:/workspace/app-one' }), workspace({ id: 'ws-c' })]
  const before = structuredClone(input)
  const result = labels.buildWorkspaceOptions(input)
  assert.equal(new Set(result.map((entry) => entry.label)).size, 3)
  assert.ok(result.every((entry) => !entry.label.includes('master · master')))
  assert.ok(result[1].label.includes('D:/workspace/app-one'))
  assert.deepEqual(result.map((entry) => entry.value), ['ws-a', 'ws-b', 'ws-c'])
  assert.deepEqual(input, before)
})
