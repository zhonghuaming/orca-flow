import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ExecutionPlan } from './protocol'
const target = { id: 'ws', name: '离线', path: 'E:/fixture', branch: 'main' }
const roles = { product: 'p', architect: 'a', developer: 'd', tester: 't' }
const base = { roles, bots: Object.values(roles).map((id) => ({ id, name: id, agent: 'fixture', paused: false })), items: [{ id: 'item', title: '按钮任务', description: '按钮可用', workspaceId: 'ws', status: 'todo' }], sprints: [], epics: [], workflows: [], runs: [], workspaces: [target] }
const context = { workspaceId: 'ws', branch: 'main', displayName: '离线', terminals: [] }
test('新Run默认快速路线，用户可选轻量且空scope随请求发送；不增加阶段批准', async () => {
  let request: Record<string, unknown> | undefined
  const h = mockHost({ results: { 'workspace.readContext': context }, requests: { 'flow.getState': base, 'flow.prepare': (input) => { request = { ...input }; return base } } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.press({ type: 'Button', text: '准备此任务' })
    assert.equal(view.valueOf({ type: 'Select', label: '执行路线' }), 'quick')
    await view.select({ type: 'Select', label: '执行路线' }, 'light')
    await view.toggle({ type: 'Checkbox', label: '涉及复杂或敏感边界，保留必要独立审查' })
    assert.equal(view.valueOf({ type: 'Select', label: '执行路线' }), 'quick')
    await view.select({ type: 'Select', label: '执行路线' }, 'light')
    assert.ok(view.find({ type: 'Button', text: '准备任务说明' })?.disabled)
    await view.toggle({ type: 'Checkbox', label: '涉及复杂或敏感边界，保留必要独立审查' })
    await view.type({ type: 'Textarea', label: '允许操作范围（只读盘点与允许修改的内容）' }, '', { replace: true })
    await view.press({ type: 'Button', text: '准备任务说明' })
    assert.equal(request?.mode, 'light')
    assert.equal(request?.scope, '')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})
test('真实Orca挂载冻结路线：进度只计两阶段，产品协调/架构未纳入而非完成，保留最终用户验收', async () => {
  const plan: ExecutionPlan = { version: 1, mode: 'quick', requiresIndependentReview: false, requiredStages: ['[Flow developer]', '[Flow tester]'], requiredRoles: ['product', 'developer', 'tester'], roles, validation: '定向回归，复用同版本证据', maxReworkRounds: 2 }
  const run = { id: 'flow', title: '按钮任务', goal: '目标', itemId: 'item', target, roles, createdAt: 1, status: 'completed', executionPlan: plan, tasks: ['developer', 'tester'].map((role, index) => ({ id: role, title: `[Flow ${role}]`, status: 'completed', deps: index ? ['developer'] : [], result: 'FLOW_EVIDENCE_V1\n{"sourceVersion":"same-content","summary":"通过","checks":["定向通过"]}' })) }
  const h = mockHost({ results: { 'workspace.readContext': context }, requests: { 'flow.getState': { ...base, runs: [run] } } })
  const view = await mount(panel, { host: h })
  try {
    await view.settled()
    await view.select({ type: 'Tabs' }, 'workflows')
    assert.ok(view.find({ type: 'Text', text: /执行路线：.*快速交付/ }))
    assert.ok(view.find({ type: 'Text', text: /执行进度：2\/2/ }))
    assert.ok(view.find({ type: 'Badge', text: '轻量协调（非阶段）' }))
    assert.ok(view.find({ type: 'Badge', text: '未纳入本路线（按需）' }))
    assert.ok(view.find({ type: 'Checkbox', label: '我已复核本路线证据与验收标准' }))
    assert.ok(view.find({ type: 'Button', text: '明确验收此任务' })?.disabled)
    assert.equal(h.calls.some((call) => JSON.stringify(call.params ?? null).includes('flow.launch')), false)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})
