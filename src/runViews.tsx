import { Badge, Button, Callout, Card, Heading, Row, Stack, Text } from 'orca'
import type { FlowRun, FlowState, NativeTask, RoleKey } from './protocol'

export const ROLES: RoleKey[] = ['product', 'architect', 'developer', 'tester']
const ROUTE_LABELS: Record<string, string> = { normal: '标准', quick: '快速交付', light: '轻量修改', complex: '复杂变更' }
export const ROLE_LABELS: Record<RoleKey, string> = { product: '产品', architect: '架构', developer: '开发', tester: '测试' }
export const LABELS: Record<string, string> = {
  todo: '待办', 'in-progress': '进行中', 'in-review': '待验收', completed: '已完成',
  planning: '规划中', active: '进行中', sending: '发送中', dispatched: '已发送，待执行',
  unknown: '发送结果未确认，请先核对，避免重复发送', waiting: '等待创建执行任务', running: '执行任务进行中',
  review: '待核验证据', failed: '失败', blocked: '阻塞', pending: '等待前置任务', ready: '可执行',
  verified: '已核对', linked: '已关联任务', accepted: '用户已验收', archived: '已归档', 'delivery-unknown': '发送结果待核对'
}
export const label = (value = '') => LABELS[value] || value
export const runLabel = (run: FlowRun) => run.archived ? '已归档' : run.acceptedAt ? '已验收' : run.status === 'completed' ? `${run.executionPlan ? '所需阶段' : '四阶段'}完成，待用户验收` : label(run.status)
export const runGroup = (run: FlowRun) => run.archived || ['completed', 'failed'].includes(run.status) ? '已结束' : ['blocked', 'unknown', 'review'].includes(run.status) ? '阻塞/待核实' : '进行中'

function stageTask(run: FlowRun, role: RoleKey) {
  const matches = run.tasks.filter((task) => task.title === `[Flow ${role}]`)
  return matches.length === 1 ? matches[0] : undefined
}

export function stageSummary(run: FlowRun) {
  return ROLES.map((role) => {
    if (run.executionPlan && !run.executionPlan.requiredStages.includes(`[Flow ${role}]`)) return `${ROLE_LABELS[role]}：${role === 'product' ? '轻量协调（非阶段）' : '未纳入（按需）'}`
    const task = stageTask(run, role)
    const status = !task ? '待核实' : task.status === 'completed' && !task.result?.trim() ? '待核实' : label(task.status)
    return `${ROLE_LABELS[role]}：${status}`
  }).join('；')
}

export function runContext(state: FlowState, run: FlowRun, contractOpen: boolean, toggleContract: () => void) {
  const item = state.items.find((entry) => entry.id === run.itemId && entry.workspaceId === run.target.id)
  const relation = (kind: 'sprints' | 'epics', id?: string) => state[kind].find((entry) => entry.id === id && entry.workspaceId === run.target.id)?.title || '未关联'
  const requiredRoles = run.executionPlan ? ROLES.filter((role) => run.executionPlan!.requiredStages.includes(`[Flow ${role}]`)) : ROLES
  const completed = requiredRoles.filter((role) => {
    const tasks = run.tasks.filter((task) => task.title === `[Flow ${role}]`)
    return tasks.length === 1 && tasks[0]?.status === 'completed' && tasks[0].result?.trim()
  }).length
  const skipped = ROLES.filter((role) => !requiredRoles.includes(role))
  return <Stack gap="sm">
    <Heading level={3}>{item?.title || run.title}</Heading>
    <Text size="xs">当前执行记录：{run.id}</Text>
    <Text size="xs">任务：{run.itemId || '旧记录未关联任务，请手动确认'}</Text>
    <Text size="xs">史诗：{relation('epics', run.itemSnapshot ? run.itemSnapshot.epicId : item?.epicId)}；迭代：{relation('sprints', run.itemSnapshot ? run.itemSnapshot.sprintId : item?.sprintId)}</Text>
    <Badge>{runLabel(run)}</Badge>
    <Text size="xs">执行路线：{run.executionPlan ? `${ROUTE_LABELS[run.executionPlan.mode] || run.executionPlan.mode}（版本 ${run.executionPlan.version}）` : '旧版四阶段流程'}</Text>
    <Text size="xs">所需角色：{requiredRoles.map((role) => ROLE_LABELS[role]).join(' → ')}；验证：{run.executionPlan?.validation || '四阶段均需证据'}</Text>
    <Text size="xs">{`执行进度：${completed}/${requiredRoles.length} 所需阶段有证据；${skipped.length ? `未纳入：${skipped.map((role) => ROLE_LABELS[role]).join('、')}。` : ''}这不是迭代完成度。`}</Text>
    {run.executionPlan ? <Text size="xs">{`本次执行返工：${run.tasks.filter((task) => /^\[Flow rework \d+\]$/.test(task.title)).length}/${run.executionPlan.maxReworkRounds} 轮；外部操作结果未确认时，请先核对，不自动重试。`}</Text> : null}
    {run.tasks.filter((task) => /^\[Flow rework \d+\]$/.test(task.title)).map((task) => <Text key={task.id} size="xs">{`返工记录 ${task.title}：${label(task.status)} · ${task.id}；${task.result || '尚无证据'}`}</Text>)}
    <Text size="xs">本次执行目标：{run.target.path} · {run.target.branch || '无分支'}</Text>
    <Text size="xs">验收标准：{run.acceptance || '旧记录未单独保存，请查阅原始目标'}</Text>
    <Text size="xs">允许操作范围：{run.scope || '旧记录未单独保存，以原始目标中的授权为准'}</Text>
    <Button size="sm" variant="ghost" onPress={toggleContract}>{contractOpen ? '收起原始任务说明' : '查看原始任务说明'}</Button>
    {contractOpen ? <Text size="xs">原始任务说明：{run.goal || (run.archived ? '原文已移至本机归档文件。' : '未保存原文。')}</Text> : null}
    <Text size="xs">发给产品 Bot 的启动消息：{run.delivery === 'not-delivered' ? '本地准备失败，确认未发送成功' : run.messageId || run.delivery === 'delivered' ? '有平台回执，不代表后续阶段已收到任务' : '发送结果未确认，请先核对，避免重复发送'}</Text>
    {run.status === 'failed' || run.status === 'blocked' ? ROLES.map((role) => {
      const task = stageTask(run, role)
      if (!task || task.status !== run.status) return null
      return <Callout key={role} tone="danger" title={`${ROLE_LABELS[role]}阶段${label(task.status)}`}>{task.result?.trim() || '尚无失败或阻塞原因说明，请查看 Orca 对应任务'}</Callout>
    }) : null}
    {run.error ? <Callout tone="danger">原始错误：{run.error}</Callout> : null}
    {run.message ? <Text size="xs">核对说明：{run.message}</Text> : null}
    <Text size="xs">下一步：{run.archived ? '原文已保存在本机归档文件，仅供查阅，不会重新执行。' : run.acceptedAt ? '已由用户确认验收；迭代状态仍需单独管理。' : run.status === 'completed' ? `复核${run.executionPlan ? '本路线' : '四阶段'}证据，再确认验收任务。` : ['blocked', 'failed', 'unknown', 'review'].includes(run.status) ? '人工核对 Orca 执行记录与失败或阻塞原因；发送结果未确认时，避免重复发送或新建替代执行。' : '等待执行任务完成，点击“核对执行结果”读取实际结果。'}</Text>
    <Text size="xs">工作区看板卡片：{nativeCardStatus(run, run.tasks.find((task) => task.itemId === run.itemId && task.workspaceId === run.target.id)).label}。Flow 任务与工作区看板中的执行任务分别保存，没有对应卡片时请手动核对。</Text>
    <Text size="xs">插件目前无法可靠地继续原聊天中的任务，因此不提供自动或一键重发。出现阻塞并不代表消息未发送成功。</Text>
  </Stack>
}

export function stages(state: FlowState, run: FlowRun) {
  const requiredRoles = run.executionPlan ? ROLES.filter((role) => run.executionPlan!.requiredStages.includes(`[Flow ${role}]`)) : ROLES
  return <Stack gap="sm">{ROLES.map((role) => {
    const tasks = run.tasks.filter((task) => task.title === `[Flow ${role}]`)
    const botId = run.roles[role]
    const included = requiredRoles.includes(role)
    return <Card key={role} title={ROLE_LABELS[role]}><Stack gap="xs">
      {!included ? <Badge>{role === 'product' ? '轻量协调（非阶段）' : '未纳入本路线（按需）'}</Badge> : null}
      <Text size="xs">本次执行角色：{state.bots.find((bot) => bot.id === botId)?.name || botId}（{botId}）</Text>
      {!included ? <Text size="xs">不计入阶段完成数，也不启动此角色任务。</Text> : !tasks.length ? <Text size="xs">尚无可核实阶段任务</Text> : tasks.map((task) => <Stack key={task.id} gap="xs">
        <Badge>{label(task.status)}</Badge><Text size="xs">Orca 任务 ID：{task.id}</Text>
        <Text size="xs">前置任务：{task.deps?.join('、') || '无/未保存'}</Text>
        <Text size="xs">{task.result || '尚无结果证据'}</Text>
      </Stack>)}
    </Stack></Card>
  })}</Stack>
}

export function nativeCardStatus(run: FlowRun, task?: NativeTask) {
  if (!task) return { label: '尚未建立对应卡片', tone: 'neutral' as const }
  return { label: `Orca 任务 ID：${task.id} · ${label(task.status)}`, tone: task.status === 'failed' || task.status === 'blocked' ? 'danger' as const : 'accent' as const }
}

export function runNavigation(run: FlowRun, navigate: (destination: string) => void, current: 'runs' | 'workflows') {
  return <Row gap="sm" wrap>
    <Button size="sm" variant="outline" onPress={() => navigate(current === 'runs' ? 'workflows' : 'runs')}>{current === 'runs' ? '查看本次团队工作流' : '查看执行记录'}</Button>
    {current === 'runs' && !run.tasks.some((task) => task.itemId === run.itemId && task.workspaceId === run.target.id) ? <Text size="xs" muted>打开工作区看板仅供手动核对，当前未找到对应卡片，不会定位到具体卡片。</Text> : null}
    {run.itemId ? <Button size="sm" variant="ghost" onPress={() => navigate('board')}>返回对应看板任务</Button> : null}
  </Row>
}
