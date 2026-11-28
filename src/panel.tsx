import {
  atom, Badge, Box, Button, Callout, Card, Checkbox, EmptyState, Heading, host, Input, on, plugin, read,
  Row, Select, set, Stack, Tab, Tabs, Text, Textarea, type PanelContext
} from 'orca'
import type { EntityKind, FlowEntity, FlowRun, FlowState, PreparedContract, RoleKey, RouteMode, StageChatLookup } from './protocol'
import { ROLES, ROLE_LABELS, label, runContext, runGroup, runLabel, runNavigation, stages, stageSummary } from './runViews'
import { buildWorkspaceOptions } from './workspaceLabels'
import { mergeInitialSnapshot, resolveFocusedWorkspaceId, type WorkspaceFocus } from './workspaceFocus'

const data = atom<FlowState>({ roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [], workspaces: [] })
const tab = atom('board')
const workspace = atom('')
const followWorkspace = atom(true)
const focusedWorkspace = atom<WorkspaceFocus | null>(null)
const busy = atom(false)
const notice = atom<{ tone: 'accent' | 'danger' | 'success'; message: string } | null>(null)
const formKind = atom<EntityKind | null>(null)
const formTitle = atom('')
const formDescription = atom('')
const formStatus = atom('todo')
const formSprint = atom('__none__')
const formEpic = atom('__none__')
const formPoints = atom('3')
const formStart = atom('')
const formEnd = atom('')
const launchOpen = atom(false)
const launchId = atom('')
const launchTitle = atom('')
const launchGoal = atom('')
const goalTarget = atom('__none__')
const deleting = atom('')
const roleDraft = atom<Partial<Record<RoleKey, string>>>({})
const nativeRunDraft = atom('')
let stageChatGeneration = 0
const stageChatLookup = atom<StageChatLookup | null>(null)
const selectedRunId = atom('')
const selectedItemId = atom('')
const launchAcceptance = atom('')
const launchScope = atom('仅限冻结工作区内完成目标所必需、可逆的离线开发；不包含生产、数据破坏、凭据、发布或权限变更授权。')
const launchMode = atom<RouteMode>('quick')
const launchReview = atom(false)
const confirmAcceptance = atom('')
const legacyItem = atom('__none__')
const confirmLink = atom(false)
const rulesOpen = atom(false)
const originalContract = atom('')
const preparedContractId = atom('')
const LANES = ['todo', 'in-progress', 'in-review', 'completed']
function selectRun(run: FlowRun, destination = 'workflows') {
  stageChatGeneration++
  set(stageChatLookup, null)
  set(selectedRunId, run.id)
  set(selectedItemId, run.itemId || '')
  set(nativeRunDraft, '')
  set(legacyItem, '__none__')
  set(confirmLink, false)
  set(confirmAcceptance, '')
  set(originalContract, '')
  set(launchOpen, false)
  set(tab, destination)
}
function currentRun(state: FlowState) {
  return state.runs.find((run) => run.id === read(selectedRunId) && run.target.id === read(workspace))
    || state.runs.find((run) => run.itemId === read(selectedItemId) && run.target.id === read(workspace))
    || state.runs.find((run) => run.target.id === read(workspace) && !run.archived && !['completed', 'failed'].includes(run.status))
    || state.runs.find((run) => run.target.id === read(workspace) && !run.archived)
}
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
function selectWorkspace(id: string) {
  if (id === read(workspace)) return
  stageChatGeneration++
  set(stageChatLookup, null)
  set(workspace, id)
  set(formKind, null)
  set(launchOpen, false)
  set(deleting, '')
  set(goalTarget, '__none__')
  set(nativeRunDraft, '')
  set(selectedRunId, '')
  set(selectedItemId, '')
  set(confirmAcceptance, '')
  set(originalContract, '')
  set(legacyItem, '__none__')
  set(confirmLink, false)
}
function pinDraft() {
  set(followWorkspace, false)
  set(notice, { tone: 'accent', message: '当前有未提交的表单，已固定原目标以保护草稿；关闭表单后可重新开启自动跟随。' })
}
function applyWorkspaceFocus() {
  if (!read(followWorkspace)) return
  const target = resolveFocusedWorkspaceId(read(focusedWorkspace), read(data).workspaces || [])
  if (target !== read(workspace) && (read(formKind) || read(launchOpen))) { pinDraft(); return }
  selectWorkspace(target)
}
function update(next: FlowState) {
  const previous = read(data)
  set(data, { ...next, workspaces: next.workspaces ?? previous.workspaces })
  applyWorkspaceFocus()
}
async function action(fn: () => Promise<void>, isCurrent = () => true) {
  if (read(busy)) return
  set(busy, true)
  set(notice, null)
  try { await fn() } catch (error) {
    // A finished lookup from a previous view must not overwrite the current notice.
    if (isCurrent()) set(notice, { tone: 'danger', message: `操作未完成：${error instanceof Error ? error.message : String(error)}` })
  } finally { set(busy, false) }
}
function stageCards(state: FlowState, run: FlowRun) {
  return stages(state, run, { busy: read(busy), lookup: read(stageChatLookup), find: (role) => {
    const generation = ++stageChatGeneration
    const isCurrent = () => generation === stageChatGeneration && read(workspace) === run.target.id && currentRun(read(data))?.id === run.id
    return action(async () => {
      set(stageChatLookup, null)
      const result = await plugin.request('flow.findStageChats', { id: run.id, workspaceId: run.target.id, role })
      if (isCurrent()) set(stageChatLookup, { runId: run.id, role, result })
    }, isCurrent)
  } })
}
function openForm(kind: EntityKind) {
  set(formKind, kind)
  set(formTitle, '')
  set(formDescription, '')
  set(formStatus, kind === 'sprints' ? 'planning' : 'todo')
  set(formSprint, '__none__')
  set(formEpic, '__none__')
  set(formPoints, '3')
  set(formStart, '')
  set(formEnd, '')
}
async function saveEntity() {
  const kind = read(formKind)
  if (!kind) return
  const description = read(formDescription)
  const entity: FlowEntity = {
    id: newId(kind), title: read(formTitle), description,
    workspaceId: read(workspace), status: read(formStatus),
    ...(kind === 'workflows' ? { goal: description } : {}),
    ...(kind === 'items' ? {
      points: Number(read(formPoints)),
      ...(read(formSprint) !== '__none__' ? { sprintId: read(formSprint) } : {}),
      ...(read(formEpic) !== '__none__' ? { epicId: read(formEpic) } : {})
    } : {}),
    ...(kind === 'sprints' ? { startDate: read(formStart), endDate: read(formEnd) } : {})
  }
  update(await plugin.request('flow.saveEntity', { kind, entity }))
  set(formKind, null)
  set(notice, { tone: 'success', message: '已保存，原有任务内容保持原文。' })
}
function prepareLaunch(title = '', goal = '') {
  set(launchId, newId('flow'))
  set(launchTitle, title)
  set(launchGoal, goal)
  set(launchAcceptance, goal)
  set(launchScope, '仅限冻结工作区内完成目标所必需、可逆的离线开发；不包含生产、数据破坏、凭据、发布或权限变更授权。')
  set(launchMode, 'quick')
  set(launchReview, false)
  set(selectedRunId, '')
  set(selectedItemId, '')
  set(goalTarget, '__none__')
  set(launchOpen, true)
}
function targetGoal(): string {
  const state = read(data)
  const selected = [...state.sprints, ...state.epics, ...state.items].find((entry) => entry.id === read(goalTarget) && entry.workspaceId === read(workspace))
  if (!selected) return read(launchGoal)
  const tasks = state.items.filter((entry) => entry.workspaceId === read(workspace) && (entry.sprintId === selected.id || entry.epicId === selected.id || entry.id === selected.id))
  return `${read(launchGoal)}\n\n目标：${selected.title}\n${selected.description}\n${tasks.map((entry) => `- [${entry.status}] ${entry.id}: ${entry.title}\n${entry.description}`).join('\n')}`
}
async function prepareContract() {
  const itemId = read(goalTarget)
  const next = await plugin.request('flow.prepare', { id: read(launchId), title: read(launchTitle), goal: targetGoal(), workspaceId: read(workspace), itemId, acceptance: read(launchAcceptance), scope: read(launchScope), mode: read(launchMode), requiresIndependentReview: read(launchReview) })
  update(next)
  set(launchOpen, false)
  set(tab, 'workflows')
  set(notice, { tone: 'accent', message: '已生成任务说明，尚未发送。未启动机器人，也未改变任务状态；请按下方步骤在机器人聊天中手动提交。' })
}
export function setup(ctx: PanelContext) {
  let revision = 0
  let businessRevision = 0
  let disposed = false
  ctx.subscriptions.push({ dispose: () => { disposed = true; revision++; stageChatGeneration++ } })
  ctx.subscriptions.push(plugin.on('flow.changed', (next) => { businessRevision++; update(next) }))
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    const previous = read(focusedWorkspace)
    const changed = previous?.workspaceId !== context?.workspaceId || previous?.branch !== context?.branch
    set(focusedWorkspace, context)
    if (changed && read(followWorkspace) && (read(formKind) || read(launchOpen))) pinDraft()
    applyWorkspaceFocus()
    if (!changed) return
    const current = ++revision
    void plugin.request('flow.getState').then((next) => {
      if (disposed || current !== revision) return
      // Refresh only workspace metadata: a slow lookup cannot overwrite newer business records.
      set(data, { ...read(data), workspaces: next.workspaces || [] })
      applyWorkspaceFocus()
    }).catch((error) => {
      if (!disposed && current === revision) set(notice, { tone: 'danger', message: `自动定位刷新失败：${error instanceof Error ? error.message : String(error)}` })
    })
  }))
  const initialRevision = revision
  const initialBusinessRevision = businessRevision
  void action(async () => {
    const [state, context] = await Promise.all([
      plugin.request('flow.getState'),
      host.call('workspace.readContext').catch(() => null)
    ])
    if (disposed) return
    if (revision === initialRevision) set(focusedWorkspace, context)
    const merged = mergeInitialSnapshot(state, read(data), revision !== initialRevision, businessRevision !== initialBusinessRevision)
    update(merged)
    set(roleDraft, merged.roles)
  })
}
function entityActions(kind: EntityKind, entity: FlowEntity) {
  const confirm = read(deleting) === entity.id
  return <Row gap="xs" wrap>
    <Button size="sm" variant="ghost" disabled={read(busy)} onPress={() => set(deleting, confirm ? '' : entity.id)}>{confirm ? '取消删除' : '删除'}</Button>
    {confirm ? <Button size="sm" tone="danger" disabled={read(busy)} onPress={() => void action(async () => {
      update(await plugin.request('flow.deleteEntity', { kind, id: entity.id, workspaceId: entity.workspaceId }))
      set(deleting, '')
    })}>确认删除</Button> : null}
  </Row>
}
function entityForm(state: FlowState) {
  const kind = read(formKind)
  if (!kind) return null
  const choices = (list: FlowEntity[]) => [{ label: '不关联', value: '__none__' }, ...list.filter((entry) => entry.workspaceId === read(workspace)).map((entry) => ({ label: entry.title, value: entry.id }))]
  return <Card title="新建内容"><Stack gap="sm">
    <Input label="名称" value={read(formTitle)} onChange={(value) => set(formTitle, value)} />
    <Textarea label={kind === 'workflows' ? '目标与验收标准' : '说明与验收标准'} rows={4} value={read(formDescription)} onChange={(value) => set(formDescription, value)} />
    {kind !== 'workflows' ? <Select label="状态" value={read(formStatus)} options={(kind === 'sprints' ? ['planning', 'active', 'completed'] : LANES).map((value) => ({ label: label(value), value }))} onChange={(value) => set(formStatus, value || 'todo')} /> : null}
    {kind === 'items' ? <>
      <Select label="关联迭代" options={choices(state.sprints)} value={read(formSprint)} onChange={(value) => set(formSprint, value || '__none__')} />
      <Select label="关联史诗" options={choices(state.epics)} value={read(formEpic)} onChange={(value) => set(formEpic, value || '__none__')} />
      <Input label="故事点" value={read(formPoints)} onChange={(value) => set(formPoints, value)} />
    </> : null}
    {kind === 'sprints' ? <Row gap="sm" wrap>
      <Input label="开始日期" placeholder="2026-12-01" value={read(formStart)} onChange={(value) => set(formStart, value)} />
      <Input label="结束日期" placeholder="2026-12-14" value={read(formEnd)} onChange={(value) => set(formEnd, value)} />
    </Row> : null}
    <Row gap="sm" wrap><Button variant="ghost" onPress={() => set(formKind, null)}>取消</Button>
      <Button disabled={read(busy) || !read(formTitle).trim() || !read(workspace)} onPress={() => void action(saveEntity)}>保存</Button></Row>
  </Stack></Card>
}
function runControls(state: FlowState, run: FlowRun) {
  return <Stack gap="sm">
    {run.messageId ? <Text size="xs">消息回执：{run.messageId}</Text> : null}
    {run.nativeRunId ? <Text size="xs">Orca 执行记录 ID：{run.nativeRunId}</Text> : null}
    {!run.archived ? <>
      {!run.nativeRunId ? <Input label="Orca 执行记录 ID（可选，未自动找到时填写）" value={read(nativeRunDraft)} onChange={(value) => set(nativeRunDraft, value)} /> : null}
      <Row gap="sm" wrap><Button size="sm" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.refreshRun', { id: run.id, ...(read(nativeRunDraft).trim() ? { nativeRunId: read(nativeRunDraft).trim() } : {}) })))}>核对执行结果</Button>
        <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => void action(async () => {
          await plugin.request('flow.openBoard', { workspaceId: run.target.id })
          set(notice, { tone: 'accent', message: `已打开目标工作区看板，未定位到具体卡片。请按记录 ID ${run.nativeRunId || run.id} 手动核对；未继续执行或重新发送任务。` })
        })}>打开工作区看板</Button></Row>
      <Text size="xs">也可用只读命令核对：orca orchestration {run.nativeRunId ? `task-list --run ${run.nativeRunId} --json` : 'run-list --json'}；请核对相同 ID，避免重复执行。</Text>
    </> : null}
    {run.itemId && run.status === 'completed' && !run.acceptedAt && !run.archived ? <Stack gap="sm">
      <Checkbox label={run.executionPlan ? '我已复核本路线证据与验收标准' : '我已复核四阶段证据与验收标准'} checked={read(confirmAcceptance) === run.id} onChange={(value) => set(confirmAcceptance, value ? run.id : '')} />
      <Button disabled={read(busy) || read(confirmAcceptance) !== run.id} onPress={() => void action(async () => { update(await plugin.request('flow.acceptRun', { id: run.id, workspaceId: run.target.id, confirm: true })); set(confirmAcceptance, '') })}>明确验收此任务</Button>
    </Stack> : null}
    {!run.itemId && !run.archived ? <Card title="关联旧执行记录"><Stack gap="sm">
      <Text size="xs">请选择同一工作区中对应的任务，不会按同名自动关联。关联后仅保存对应关系，不改变历史、验收标准或发送状态。</Text>
      <Select label="关联同工作区任务" value={read(legacyItem)} options={[{ label: '请选择任务', value: '__none__' }, ...state.items.filter((item) => item.workspaceId === run.target.id).map((item) => ({ label: `${item.title}（${item.id}）`, value: item.id }))]} onChange={(value) => { set(legacyItem, value || '__none__'); set(confirmLink, false) }} />
      <Checkbox label="确认此执行记录属于所选任务" checked={read(confirmLink)} onChange={(value) => set(confirmLink, Boolean(value))} />
      <Button disabled={read(busy) || !read(confirmLink) || read(legacyItem) === '__none__'} onPress={() => void action(async () => { update(await plugin.request('flow.linkRun', { id: run.id, itemId: read(legacyItem), workspaceId: run.target.id, confirm: true })); set(confirmLink, false) })}>确认关联旧执行记录</Button>
    </Stack></Card> : null}
    {run.archiveFile ? <Text size="xs">原始目标与记录已保存在本机：{run.archiveFile}</Text> : null}
    {['completed', 'failed'].includes(run.status) && run.delivery !== 'unknown' && !run.archived && (!run.itemId || run.acceptedAt || run.status === 'failed') ? <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.archiveRun', { id: run.id })))}>归档详细记录（保留本机原文）</Button> : null}
  </Stack>
}
function preparedView(entry: PreparedContract) {
  return <Card key={entry.id} title={`已准备：${entry.title}`}><Stack gap="sm">
    <Callout tone="accent">已生成任务说明，尚未发送。未创建执行记录或执行任务，未启动模型；这不是执行或验收结果。</Callout>
    <Text size="xs">准备记录 ID：{entry.id}；任务：{entry.itemId || '无关联'}；路线：{entry.executionPlan ? ({ quick: '快速交付', normal: '标准', light: '轻量修改', complex: '复杂变更' })[entry.executionPlan.mode] : '未记录'}</Text>
    <Text size="xs">产品 Bot：{entry.productBot.name} · bot:{entry.productBot.id}</Text>
    <Text size="xs">本次执行目标：{entry.target.name} · {entry.target.id} · {entry.target.path} · 分支：{entry.target.branch ?? '无'} · 项目 ID：{entry.target.projectId ?? '无'} · 执行主机：{entry.target.hostId ?? 'local'}</Text>
    <Text size="xs">验收标准：{entry.acceptance || '沿用目标'}；允许操作范围：{entry.scope}</Text>
    <Text size="xs">任务说明原文文件（UTF-8）：{entry.contractFile}</Text>
    <Button size="sm" variant="outline" onPress={() => set(preparedContractId, read(preparedContractId) === entry.id ? '' : entry.id)}>{read(preparedContractId) === entry.id ? '收起任务说明原文' : '查看任务说明原文'}</Button>
    {read(preparedContractId) === entry.id ? <Text size="xs">{entry.contract}</Text> : null}
    <Text size="xs">1. 在 Orca 机器人列表中找到上述名称及 ID，打开该产品 Bot 的聊天，核对机器人和本次执行工作区。</Text>
    <Text size="xs">2. 用本机编辑器打开上述 UTF-8 文件，全选并复制完整任务说明原文，再粘贴到该聊天；不要只提交文件路径或摘要。目标、角色或路线已变时不要提交旧任务说明。</Text>
    <Text size="xs">3. 复核允许操作范围后，由你在聊天中明确点击提交；这一步才可能启动 Bot 并消耗模型额度。发送结果未确认，请先核对原聊天，避免重复发送。</Text>
    <Text size="xs">插件不会自动打开指定聊天或发送消息。手动提交后，此处仍是准备记录，不会自动导入执行记录或自动验收；请在 Orca 聊天与执行记录中查看真实结果。</Text>
  </Stack></Card>
}
export default function Panel() {
  const state = read(data)
  const selectedWs = (state.workspaces || []).find((entry) => entry.id === read(workspace))
  const local = (kind: EntityKind) => state[kind].filter((entry) => entry.workspaceId === read(workspace))
  const currentTab = read(tab)
  const feedback = read(notice)
  const readyRoles = ROLES.every((role) => state.roles[role]) && state.bots.some((bot) => bot.id === state.roles.product && !bot.paused)
  const selectedRun = currentRun(state)
  const workspaceRuns = state.runs.filter((run) => run.target.id === read(workspace))
  return <Box width="100%" minWidth={0} maxWidth="100%" gap="md">
    <Row justify="between" gap="sm" align="center" wrap>
      <Stack gap="xs"><Heading level={2}>Orca Flow</Heading><Text size="xs" muted>产品轻量协调，默认开发 → 测试；架构按需参与</Text></Stack>
      <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.getState')))}>刷新面板</Button>
    </Row>
    {feedback ? <Callout tone={feedback.tone}>{feedback.message}</Callout> : null}
    <Card title="目标工作区"><Stack gap="sm">
      {(state.workspaces || []).length ? <Select label="目标工作区" value={read(workspace) || '__none__'} options={[{ label: '请选择目标工作区', value: '__none__' }, ...buildWorkspaceOptions(state.workspaces || [])]} disabled={read(busy)} onChange={(value) => { set(followWorkspace, false); selectWorkspace(value === '__none__' ? '' : value || '') }} /> : <Text>暂无工作区，请先在 Orca 打开项目。</Text>}
      <Checkbox label="自动跟随当前工作区" description="切换项目或工作区时自动定位；手动选择后固定目标。" checked={read(followWorkspace)} disabled={read(busy) || Boolean(read(formKind) || read(launchOpen))} onChange={(value) => { set(followWorkspace, Boolean(value)); applyWorkspaceFocus() }} />
      {selectedWs ? <Text size="xs" muted>{selectedWs.path}</Text> : <Text size="xs" muted>当前未定位到唯一工作区，请打开项目或手动选择目标。</Text>}
      <Text size="xs" muted>已准备任务说明与已有流程始终固定原项目、路径与分支，不会随界面焦点切换。</Text>
    </Stack></Card>
    <Box width="100%" minWidth={0} maxWidth="100%" scroll="x">
    <Tabs label="Flow 导航" value={currentTab} onChange={(value) => { set(tab, value || 'board'); set(formKind, null) }}>
      <Tab value="board" label="敏捷看板" icon="blocks"><Stack gap="sm">
        <Row gap="sm" wrap><Button disabled={!selectedWs} onPress={() => openForm('items')}>新建任务</Button>
          <Button variant="outline" disabled={!selectedWs || read(busy)} onPress={() => void action(async () => {
            await plugin.request('flow.openBoard', { workspaceId: read(workspace) })
            set(notice, { tone: 'accent', message: '已打开工作区看板，未定位到具体卡片。Flow 中的任务不会自动成为工作区看板中的执行任务。' })
          })}>打开工作区看板</Button></Row>
        {entityForm(state)}
        {read(selectedItemId) ? <Text size="xs">当前任务：{read(selectedItemId)}</Text> : null}
        {!local('items').length ? <EmptyState title="暂无任务" description="创建任务并关联迭代与史诗。用户输入保持原文。" /> : local('items').map((item) => {
          const linked = workspaceRuns.filter((run) => run.itemId === item.id)
          const latest = linked.reduce<FlowRun | undefined>((best, run) => !best || run.createdAt > best.createdAt ? run : best, undefined)
          const inspect = latest?.status === 'failed' || latest?.status === 'blocked'
          return <Card key={item.id} title={item.title}><Stack gap="sm">
            <Row gap="xs" wrap><Badge>{`任务：${label(item.status)}`}</Badge>{latest ? <Badge tone={inspect ? 'danger' : 'neutral'}>{`最近执行：${runLabel(latest)}`}</Badge> : null}<Text size="xs" muted>{`故事点：${item.points ?? '待估'}`}</Text></Row>
            {latest ? <Text size="xs">{stageSummary(latest)}</Text> : null}
            {item.description ? <Text size="xs">{item.description}</Text> : null}
            <Row gap="xs" wrap>{LANES.map((lane) => <Button key={lane} size="sm" variant={item.status === lane ? 'solid' : 'ghost'} disabled={read(busy) || workspaceRuns.some((run) => run.itemId === item.id && (lane === 'completed' || (Boolean(run.acceptedAt) && item.status === 'completed')))} onPress={() => void action(async () => update(await plugin.request('flow.saveEntity', { kind: 'items', entity: { ...item, status: lane } })))}>{label(lane)}</Button>)}</Row>
            <Row gap="sm" wrap><Button size="sm" variant="outline" onPress={() => {
              if (latest) { selectRun(latest, inspect ? 'runs' : 'workflows'); return }
              set(tab, 'workflows'); prepareLaunch(item.title, item.description); set(goalTarget, item.id); set(selectedItemId, item.id)
            }}>{latest?.status === 'failed' ? '查看失败原因' : latest?.status === 'blocked' ? '查看阻塞原因' : latest ? '查看工作流' : '准备此任务'}</Button>{entityActions('items', item)}</Row>
          </Stack></Card>})}
      </Stack></Tab>
      <Tab value="roadmap" label="路线图" icon="flag"><Stack gap="md">
        <Row gap="sm" wrap><Button disabled={!selectedWs} onPress={() => openForm('epics')}>新建史诗</Button><Button disabled={!selectedWs} onPress={() => openForm('sprints')}>新建迭代</Button></Row>
        {entityForm(state)}
        {(['epics', 'sprints'] as EntityKind[]).map((kind) => <Stack key={kind} gap="sm">
          <Heading level={3}>{kind === 'epics' ? '史诗' : '迭代'}</Heading>
          {!local(kind).length ? <EmptyState title={kind === 'epics' ? '暂无史诗' : '暂无迭代'} /> : local(kind).map((entity) => <Card key={entity.id} title={entity.title}>
            <Stack gap="sm"><Text size="xs">{entity.description}</Text><Row gap="sm" wrap><Badge>{label(entity.status)}</Badge>
              {kind === 'sprints' ? <Text size="xs">{entity.startDate || '开始日期未定'} → {entity.endDate || '结束日期未定'}</Text> : null}
              {entityActions(kind, entity)}
              <Button size="sm" variant="outline" onPress={() => { set(tab, 'board'); set(notice, { tone: 'accent', message: `请从看板选择 ${entity.title} 下的具体任务，再准备任务说明；每次执行对应一项任务，而不是整个迭代。` }) }}>查看关联任务</Button>
            </Row>
            <Text size="xs">迭代/史诗完成度：{local('items').filter((item) => item[kind === 'sprints' ? 'sprintId' : 'epicId'] === entity.id && item.status === 'completed').length}/{local('items').filter((item) => item[kind === 'sprints' ? 'sprintId' : 'epicId'] === entity.id).length} 任务；与四角色阶段进度独立。</Text>
            {kind === 'sprints' ? <Row gap="xs" wrap>{['planning', 'active', 'completed'].map((status) => <Button key={status} size="sm" variant="ghost" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.saveEntity', { kind, entity: { ...entity, status } })))}>{label(status)}</Button>)}</Row> : null}
          </Stack></Card>)}
        </Stack>)}
      </Stack></Tab>
      <Tab value="workflows" label="团队工作流" icon="layers"><Stack gap="md">
        <Heading level={3}>已准备的任务说明（尚未发送）</Heading>
        <Text size="xs">保存后可在此继续查看，最多 32 份，另受总存储容量限制。已有执行与草稿保持不变；如有待核对的执行，请先核对，避免重复发送。准备不代表已执行或验收。</Text>
        {(state.prepared || []).filter((entry) => entry.target.id === read(workspace)).map((entry) => preparedView(entry))}
        <Heading level={3}>已有执行记录</Heading>
        {selectedRun && !read(launchOpen) ? <>
          {workspaceRuns.length > 1 ? <Select label="当前执行记录" value={selectedRun.id} options={workspaceRuns.map((run) => ({ label: `${run.title}（${run.id}）`, value: run.id }))} onChange={(value) => { const run = workspaceRuns.find((entry) => entry.id === value); if (run) selectRun(run) }} /> : null}
          {runContext(state, selectedRun, read(originalContract) === selectedRun.id, () => set(originalContract, read(originalContract) === selectedRun.id ? '' : selectedRun.id))}
          {runNavigation(selectedRun, (destination) => selectRun(selectedRun, destination), 'workflows')}
          {stageCards(state, selectedRun)}
          {runControls(state, selectedRun)}
        </> : <>
          <Text size="xs">从看板选择具体任务，确认范围后准备任务说明；尚无执行记录时，可查看角色与模板。</Text>
          <Text size="xs">四角色：{ROLES.map((role) => `${ROLE_LABELS[role]}：${state.bots.find((bot) => bot.id === state.roles[role])?.name || state.roles[role] || '未绑定'}`).join('；')}</Text>
          <Row gap="sm" wrap><Button disabled={!selectedWs} onPress={() => prepareLaunch()}>准备任务说明草稿</Button><Button variant="outline" disabled={!selectedWs} onPress={() => openForm('workflows')}>保存工作流模板</Button></Row>
          {entityForm(state)}
          {local('workflows').map((entity) => <Card key={entity.id} title={entity.title}><Stack gap="sm"><Text size="xs">{entity.goal || entity.description}</Text>
            <Row gap="sm" wrap><Button size="sm" onPress={() => prepareLaunch(entity.title, entity.goal || entity.description)}>使用此模板</Button>{entityActions('workflows', entity)}</Row></Stack></Card>)}
        </>}
        <Button size="sm" variant="ghost" onPress={() => set(rulesOpen, !read(rulesOpen))}>{read(rulesOpen) ? '收起协作规则' : '展开协作规则'}</Button>
        {read(rulesOpen) ? <Callout tone="accent">插件仅生成任务说明，不发送消息或启动 Bot；由你在机器人聊天中提交后才可能执行。不创建额外机器人、不改变 Bot 权限。普通离线开发不需逐阶段批准；确认测试失败后在同一次执行内最多两轮返工。发送结果未确认，请先核对，避免重复发送。阶段完成不等于用户验收或迭代完成。</Callout> : null}
        {read(launchOpen) ? <Card title="确认本次目标"><Stack gap="sm">
          <Text size="xs">本次执行工作区：{selectedWs?.name || '未选择'} · {selectedWs?.path || ''}</Text>
          <Text size="xs">产品 Bot：{state.bots.find((bot) => bot.id === state.roles.product)?.name || '名称未确认，请先发现机器人'} · bot:{state.roles.product || '未绑定'}</Text>
          <Input label="目标名称" value={read(launchTitle)} onChange={(value) => set(launchTitle, value)} />
          <Select label="执行路线" value={read(launchMode)} options={[{ label: '快速交付：开发 → 测试（默认）', value: 'quick' }, { label: '标准：开发 → 测试', value: 'normal' }, { label: '轻量修改：开发自验', value: 'light' }, { label: '复杂变更：架构 → 开发 → 测试', value: 'complex' }]} onChange={(value) => set(launchMode, (value || 'quick') as RouteMode)} />
          <Checkbox label="涉及复杂或敏感边界，保留必要独立审查" checked={read(launchReview)} onChange={(value) => { set(launchReview, Boolean(value)); if (value && read(launchMode) === 'light') set(launchMode, 'quick') }} />
          {read(launchReview) && read(launchMode) === 'light' ? <Callout tone="danger">已声明需要独立审查，请选择快速、标准或复杂路线。</Callout> : null}
          <Text size="xs">生成任务说明后，本次路线保持不变。产品负责协调，不单设执行阶段，架构按需参与；轻量路线仍需处理敏感操作所需的审查。</Text>
          <Textarea label="目标与验收标准" rows={6} value={read(launchGoal)} onChange={(value) => set(launchGoal, value)} />
          <Select label="关联任务" value={read(goalTarget)} options={[{ label: '请选择看板任务', value: '__none__' }, ...local('items').map((entry) => ({ label: `${entry.title}（${entry.id}）`, value: entry.id }))]} onChange={(value) => {
            const item = local('items').find((entry) => entry.id === value)
            const run = workspaceRuns.find((entry) => entry.itemId === value)
            if (run) { selectRun(run); return }
            set(goalTarget, value || '__none__'); set(selectedItemId, item?.id || '')
          }} />
          <Textarea label="本次验收标准" rows={3} value={read(launchAcceptance)} onChange={(value) => set(launchAcceptance, value)} />
          <Textarea label="允许操作范围（只读盘点与允许修改的内容）" rows={3} value={read(launchScope)} onChange={(value) => set(launchScope, value)} />
          <Text size="xs">本次执行角色：{ROLES.map((role) => `${ROLE_LABELS[role]}：${state.bots.find((bot) => bot.id === state.roles[role])?.name || '未绑定'}`).join('；')}</Text>
          <Callout tone="accent">生成任务说明后尚未发送，不启动模型、不改变任务状态。之后需你在机器人聊天中提交，才可能启动 Bot 并消耗额度。插件不会自动打开指定聊天；本次操作不授权生产、凭据读取或权限变更。</Callout>
          <Row gap="sm" wrap><Button variant="ghost" onPress={() => set(launchOpen, false)}>取消</Button><Button disabled={read(busy) || (read(launchReview) && read(launchMode) === 'light') || !readyRoles || !selectedWs || read(goalTarget) === '__none__' || !read(launchAcceptance).trim() || !read(launchTitle).trim() || !targetGoal().trim()} onPress={() => void action(prepareContract)}>准备任务说明</Button></Row>
        </Stack></Card> : null}
      </Stack></Tab>
      <Tab value="bots" label="机器人" icon="bot"><Stack gap="md">
        <Callout tone="accent">仅引用已存在的四个独立机器人；本插件不创建机器人、不改权限、不读取登录凭据。配置、模型与工具审批由 Orca 管理。</Callout>
        <Button disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.refreshBots')))}>发现本机机器人</Button>
        {!state.bots.length ? <EmptyState title="尚未发现机器人" description="点击“发现本机机器人”读取 Orca 机器人列表，不会启动模型任务。" /> : <Card title="绑定四角色"><Stack gap="sm">
          {ROLES.map((role) => <Select key={role} label={`${ROLE_LABELS[role]}机器人`} value={read(roleDraft)[role] || '__none__'} options={[{ label: '请选择', value: '__none__' }, ...state.bots.map((bot) => ({ label: `${bot.name}${bot.paused ? '（已暂停）' : ''}`, value: bot.id }))]} onChange={(value) => set(roleDraft, { ...read(roleDraft), [role]: value === '__none__' ? '' : value || '' })} />)}
          <Button disabled={read(busy)} onPress={() => void action(async () => {
            update(await plugin.request('flow.saveRoles', { roles: read(roleDraft) }))
            set(notice, { tone: 'success', message: '四角色绑定已保存；未更改机器人本身或权限。' })
          })}>保存四角色绑定</Button>
        </Stack></Card>}
      </Stack></Tab>
      <Tab value="runs" label="执行记录" icon="activity"><Stack gap="md">
        <Text size="xs">这里只显示当前工作区已有的执行记录，任务说明另列在团队工作流中。核对只读取结果，不处理机器人待收消息，也不会重新执行。</Text>
        {!workspaceRuns.length ? <EmptyState title="当前工作区暂无执行记录" description="从看板选择任务，在团队工作流中确认目标。" /> : <>
          {['进行中', '阻塞/待核实', '已结束'].map((group) => <Stack key={group} gap="sm">
            <Heading level={3}>{group}</Heading>
            {workspaceRuns.filter((run) => runGroup(run) === group).map((run) => <Button key={run.id} variant={selectedRun?.id === run.id ? 'solid' : 'outline'} onPress={() => selectRun(run, 'runs')}>{run.title} · {runLabel(run)} · {run.id}</Button>)}
          </Stack>)}
          {selectedRun ? <Card title="执行详情"><Stack gap="sm">
            {runContext(state, selectedRun, read(originalContract) === selectedRun.id, () => set(originalContract, read(originalContract) === selectedRun.id ? '' : selectedRun.id))}
            {runNavigation(selectedRun, (destination) => selectRun(selectedRun, destination), 'runs')}
            {runControls(state, selectedRun)}
            {stageCards(state, selectedRun)}
            <Heading level={3}>近期关键历史</Heading>
            {!selectedRun.events?.length ? <Text size="xs">旧记录未保存事件历史；刷新仅核对当前结果，不会补充过去的事件。</Text> : selectedRun.events.map((entry, index) => <Text key={`${entry.at}-${index}`} size="xs">{new Date(entry.at).toLocaleString()} · {label(entry.kind)}：{entry.detail}</Text>)}
          </Stack></Card> : <Text size="xs">选择执行记录，查看结果证据与历史。</Text>}
        </>}
      </Stack></Tab>
    </Tabs>
    </Box>
  </Box>
}
