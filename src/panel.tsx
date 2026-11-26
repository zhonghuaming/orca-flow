import {
  atom, Badge, Box, Button, Callout, Card, EmptyState, Heading, Input, plugin, read,
  Row, Select, set, Stack, Tab, Tabs, Text, Textarea, type PanelContext
} from 'orca'
import type { EntityKind, FlowEntity, FlowState, RoleKey } from './protocol'
import { buildWorkspaceOptions } from './workspaceLabels'

const data = atom<FlowState>({ roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [], workspaces: [] })
const tab = atom('board')
const workspace = atom('')
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
const ROLES: RoleKey[] = ['product', 'architect', 'developer', 'tester']
const ROLE_LABELS: Record<RoleKey, string> = { product: '产品', architect: '架构', developer: '开发', tester: '测试' }
const LABELS: Record<string, string> = {
  todo: '待办', 'in-progress': '进行中', 'in-review': '待审查', completed: '已完成',
  planning: '规划中', active: '进行中', sending: '投递中', dispatched: '已投递，待执行',
  unknown: '结果未知，勿重发', waiting: '等待原生任务', running: '原生任务进行中',
  review: '待核验证据', failed: '失败', blocked: '阻塞', pending: '等待依赖', ready: '可执行'
}
const LANES = ['todo', 'in-progress', 'in-review', 'completed']
const label = (value = '') => LABELS[value] || value
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
function update(next: FlowState) {
  const previous = read(data)
  set(data, { ...next, workspaces: next.workspaces ?? previous.workspaces })
  if (!read(workspace) && next.workspaces?.length) set(workspace, next.workspaces[0]!.id)
}
async function action(fn: () => Promise<void>) {
  if (read(busy)) return
  set(busy, true)
  set(notice, null)
  try { await fn() } catch (error) {
    set(notice, { tone: 'danger', message: `操作未完成：${error instanceof Error ? error.message : String(error)}` })
  } finally { set(busy, false) }
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
async function launch() {
  update(await plugin.request('flow.launch', { id: read(launchId), title: read(launchTitle), goal: targetGoal(), workspaceId: read(workspace) }))
  set(launchOpen, false)
  set(tab, 'runs')
  set(notice, { tone: 'accent', message: '已投递给产品 Bot，等待建立原生四阶段任务；这不代表模型执行或验收成功。' })
}
export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(plugin.on('flow.changed', update))
  void action(async () => {
    const state = await plugin.request('flow.getState')
    update(state)
    set(roleDraft, state.roles)
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
export default function Panel() {
  const state = read(data)
  const selectedWs = (state.workspaces || []).find((entry) => entry.id === read(workspace))
  const local = (kind: EntityKind) => state[kind].filter((entry) => entry.workspaceId === read(workspace))
  const currentTab = read(tab)
  const feedback = read(notice)
  const readyRoles = ROLES.every((role) => state.roles[role])
  return <Box width="100%" minWidth={0} maxWidth="100%" gap="md">
    <Row justify="between" gap="sm" align="center" wrap>
      <Stack gap="xs"><Heading level={2}>Orca Flow</Heading><Text size="xs" muted>原生四角色协作：产品 → 架构 → 开发 → 测试</Text></Stack>
      <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.getState')))}>刷新面板</Button>
    </Row>
    {feedback ? <Callout tone={feedback.tone}>{feedback.message}</Callout> : null}
    <Card title="目标工作区"><Stack gap="sm">
      {(state.workspaces || []).length ? <Select label="目标工作区" value={read(workspace)} options={buildWorkspaceOptions(state.workspaces || [])} disabled={read(busy)} onChange={(value) => { set(workspace, value || ''); set(formKind, null); set(launchOpen, false) }} /> : <Text>暂无工作区，请先在 Orca 打开项目。</Text>}
      {selectedWs ? <Text size="xs" muted>{selectedWs.path}</Text> : null}
      <Text size="xs" muted>启动时冻结项目、路径与分支，不会跟随焦点切换；机器人必须先核对真实执行位置。</Text>
    </Stack></Card>
    <Box width="100%" minWidth={0} maxWidth="100%" scroll="x">
    <Tabs label="Flow 导航" value={currentTab} onChange={(value) => { set(tab, value || 'board'); set(formKind, null) }}>
      <Tab value="board" label="敏捷看板" icon="blocks"><Stack gap="sm">
        <Row gap="sm" wrap><Button disabled={!selectedWs} onPress={() => openForm('items')}>新建任务</Button>
          <Button variant="outline" disabled={!selectedWs || read(busy)} onPress={() => void action(async () => {
            await plugin.request('flow.openBoard', { workspaceId: read(workspace) })
            set(notice, { tone: 'accent', message: '已打开原生工作区看板；本插件业务任务不会伪造为终端任务。' })
          })}>打开原生看板</Button></Row>
        {entityForm(state)}
        {!local('items').length ? <EmptyState title="暂无任务" description="创建任务并关联迭代与史诗。用户输入保持原文。" /> : local('items').map((item) => <Card key={item.id} title={item.title}>
          <Stack gap="sm"><Text>{item.title}</Text><Text size="xs">{item.description}</Text>
            <Row gap="xs" wrap><Badge>{label(item.status)}</Badge><Text size="xs">故事点：{item.points ?? 0}</Text></Row>
            <Row gap="xs" wrap>{LANES.map((lane) => <Button key={lane} size="sm" variant={item.status === lane ? 'solid' : 'ghost'} disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.saveEntity', { kind: 'items', entity: { ...item, status: lane } })))}>{label(lane)}</Button>)}</Row>
            <Row gap="sm" wrap><Button size="sm" variant="outline" onPress={() => { set(tab, 'workflows'); prepareLaunch(item.title, item.description); set(goalTarget, item.id) }}>准备此任务</Button>{entityActions('items', item)}</Row>
          </Stack></Card>)}
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
              <Button size="sm" variant="outline" onPress={() => { set(tab, 'workflows'); prepareLaunch(entity.title, entity.description); set(goalTarget, entity.id) }}>准备关联任务</Button>
            </Row>
            {kind === 'sprints' ? <Row gap="xs" wrap>{['planning', 'active', 'completed'].map((status) => <Button key={status} size="sm" variant="ghost" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.saveEntity', { kind, entity: { ...entity, status } })))}>{label(status)}</Button>)}</Row> : null}
          </Stack></Card>)}
        </Stack>)}
      </Stack></Tab>
      <Tab value="workflows" label="团队工作流" icon="layers"><Stack gap="md">
        <Callout tone="accent">只向已绑定的产品 Bot 投递一次；产品 Bot 使用 Orca 原生 Run、依赖任务和消息依次协调架构、开发与测试。不会创建额外机器人或修改权限。</Callout>
        <Row gap="sm" wrap><Button disabled={!selectedWs} onPress={() => prepareLaunch()}>准备启动</Button><Button variant="outline" disabled={!selectedWs} onPress={() => openForm('workflows')}>保存工作流模板</Button></Row>
        {entityForm(state)}
        {local('workflows').map((entity) => <Card key={entity.id} title={entity.title}><Stack gap="sm"><Text size="xs">{entity.goal || entity.description}</Text>
          <Row gap="sm" wrap><Button size="sm" onPress={() => prepareLaunch(entity.title, entity.goal || entity.description)}>使用此模板</Button>{entityActions('workflows', entity)}</Row></Stack></Card>)}
        {read(launchOpen) ? <Card title="确认本次目标"><Stack gap="sm">
          <Text size="xs">冻结工作区：{selectedWs?.name || '未选择'} · {selectedWs?.path || ''}</Text>
          <Input label="目标名称" value={read(launchTitle)} onChange={(value) => set(launchTitle, value)} />
          <Textarea label="目标与验收标准" rows={6} value={read(launchGoal)} onChange={(value) => set(launchGoal, value)} />
          <Select label="附加看板目标" value={read(goalTarget)} options={[{ label: '仅使用上方目标', value: '__none__' }, ...['sprints', 'epics', 'items'].flatMap((kind) => local(kind as EntityKind).map((entry) => ({ label: entry.title, value: entry.id })))]} onChange={(value) => set(goalTarget, value || '__none__')} />
          <Text size="xs">四角色绑定：{ROLES.map((role) => `${ROLE_LABELS[role]}：${state.bots.find((bot) => bot.id === state.roles[role])?.name || '未绑定'}`).join('；')}</Text>
          <Callout tone="accent">发送后会启动真实原生 Bot 工作，可能消耗所配置模型额度。未知投递不自动重试；不包含生产、凭据或权限扩张授权。</Callout>
          <Row gap="sm" wrap><Button variant="ghost" onPress={() => set(launchOpen, false)}>取消</Button><Button disabled={read(busy) || !readyRoles || !selectedWs || !read(launchTitle).trim() || !targetGoal().trim()} onPress={() => void action(launch)}>发送给产品 Bot</Button></Row>
        </Stack></Card> : null}
      </Stack></Tab>
      <Tab value="bots" label="原生机器人" icon="bot"><Stack gap="md">
        <Callout tone="accent">仅引用已存在的四个独立机器人；本插件不创建机器人、不改权限、不读取登录凭据。配置、模型与工具审批由 Orca 管理。</Callout>
        <Button disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.refreshBots')))}>发现本机机器人</Button>
        {!state.bots.length ? <EmptyState title="尚未发现机器人" description="点击发现按钮读取 Orca 原生 Bot 列表，不会启动模型任务。" /> : <Card title="绑定四角色"><Stack gap="sm">
          {ROLES.map((role) => <Select key={role} label={`${ROLE_LABELS[role]}机器人`} value={read(roleDraft)[role] || '__none__'} options={[{ label: '请选择', value: '__none__' }, ...state.bots.map((bot) => ({ label: `${bot.name}${bot.paused ? '（已暂停）' : ''}`, value: bot.id }))]} onChange={(value) => set(roleDraft, { ...read(roleDraft), [role]: value === '__none__' ? '' : value || '' })} />)}
          <Button disabled={read(busy)} onPress={() => void action(async () => {
            update(await plugin.request('flow.saveRoles', { roles: read(roleDraft) }))
            set(notice, { tone: 'success', message: '四角色绑定已保存；未更改机器人本身或权限。' })
          })}>保存四角色绑定</Button>
        </Stack></Card>}
      </Stack></Tab>
      <Tab value="runs" label="运行记录" icon="activity"><Stack gap="md">
        <Callout tone="accent">消息回执仅代表投递。刷新会读取原生 Run 与任务结果，不消费协调邮箱、不查询供应商、不自动重放失败工作。</Callout>
        {!state.runs.length ? <EmptyState title="暂无运行记录" description="在团队工作流中确认目标并发送给产品 Bot。" /> : state.runs.filter((run) => run.target.id === read(workspace)).map((run) => <Card key={run.id} title={run.title}>
          <Stack gap="sm"><Badge tone={run.status === 'failed' || run.status === 'unknown' ? 'danger' : run.status === 'completed' ? 'success' : 'accent'}>{label(run.status)}</Badge>
            <Text size="xs">关联标记：{run.id}</Text><Text size="xs">目标：{run.target.path} · {run.target.branch || '无分支'}</Text>
            {run.messageId ? <Text size="xs">消息回执：{run.messageId}</Text> : null}
            {run.nativeRunId ? <Text size="xs">原生 Run：{run.nativeRunId}</Text> : null}
            {run.message ? <Text size="xs">{run.message}</Text> : null}
            {run.error ? <Callout tone="danger">原始错误：{run.error}</Callout> : null}
            <Input label="原生 runId（可选，自动发现不到时填写）" value={read(nativeRunDraft)} onChange={(value) => set(nativeRunDraft, value)} />
            <Button size="sm" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.refreshRun', { id: run.id, ...(read(nativeRunDraft).trim() ? { nativeRunId: read(nativeRunDraft).trim() } : {}) })))}>核对原生任务</Button>
            {run.archiveFile ? <Text size="xs">原始目标与记录已保存在本机：{run.archiveFile}</Text> : null}
            {['completed', 'failed'].includes(run.status) && !run.archived ? <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => void action(async () => update(await plugin.request('flow.archiveRun', { id: run.id })))}>归档详细记录（保留本机原文）</Button> : null}
            {run.tasks.map((task) => <Card key={task.id} title={task.title}><Stack gap="xs"><Badge>{label(task.status)}</Badge><Text size="xs">{task.result || '尚无结果证据'}</Text></Stack></Card>)}
          </Stack></Card>)}
      </Stack></Tab>
    </Tabs>
    </Box>
  </Box>
}
