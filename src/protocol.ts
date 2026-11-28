export type RoleKey = 'product' | 'architect' | 'developer' | 'tester'
export type EntityKind = 'items' | 'sprints' | 'epics' | 'workflows'
export interface FlowBot { id: string; name: string; agent: string; paused: boolean }
export interface Workspace { id: string; name: string; path: string; branch?: string | null; projectId?: string | null; hostId?: string | null; projectName?: string | null }
export interface FlowEntity {
  id: string
  title: string
  description: string
  workspaceId: string
  status?: string
  sprintId?: string
  epicId?: string
  points?: number
  startDate?: string
  endDate?: string
  goal?: string
}
export type RouteMode = 'normal' | 'quick' | 'light' | 'complex'
export interface ExecutionPlan {
  version: 1
  mode: RouteMode
  requiredStages: string[]
  requiredRoles: RoleKey[]
  roles: Partial<Record<RoleKey, string>>
  validation: string
  maxReworkRounds: number
  requiresIndependentReview: boolean
}
export interface StageChats {
  botId: string
  botName: string
  match: 'title-candidates'
  truncated: boolean
  chats: { id: string; title: string; closed: boolean }[]
}
export interface StageChatLookup { runId: string; role: RoleKey; result: StageChats }
export interface NativeTask { id: string; title: string; status: string; deps: string[] | null; result?: string; itemId?: string; workspaceId?: string }
export interface FlowRun {
  id: string
  title: string
  goal: string
  target: Workspace
  roles: Record<RoleKey, string>
  status: string
  createdAt: number
  messageId?: string
  nativeRunId?: string
  error?: string
  message?: string
  tasks: NativeTask[]
  executionPlan?: ExecutionPlan
  archived?: boolean
  archiveFile?: string
  itemId?: string
  itemSnapshot?: { title: string; sprintId?: string; epicId?: string }
  acceptance?: string
  scope?: string
  delivery?: 'delivered' | 'not-delivered' | 'unknown'
  checkedAt?: number
  acceptedAt?: number
  events?: { kind: string; at: number; detail: string; fingerprint: string }[]
}
export interface PreparedContract extends Pick<FlowRun, 'id' | 'title' | 'goal' | 'target' | 'roles' | 'createdAt' | 'executionPlan' | 'itemId' | 'itemSnapshot' | 'acceptance' | 'scope'> {
  status: 'prepared'
  productBot: { id: string; name: string }
  contract: string
  contractFile: string
}
export interface PrepareInput { id: string; title: string; goal: string; workspaceId: string; itemId?: string; acceptance?: string; scope?: string; mode?: RouteMode; requiresIndependentReview?: boolean }
export interface FlowState {
  roles: Partial<Record<RoleKey, string>>
  bots: FlowBot[]
  sprints: FlowEntity[]
  epics: FlowEntity[]
  items: FlowEntity[]
  workflows: FlowEntity[]
  runs: FlowRun[]
  prepared?: PreparedContract[]
  workspaces?: Workspace[]
}
declare module 'orca' {
  interface PluginRequests {
    'flow.getState': { input: void; output: FlowState }
    'flow.refreshBots': { input: void; output: FlowState }
    'flow.saveRoles': { input: { roles: Partial<Record<RoleKey, string>> }; output: FlowState }
    'flow.saveEntity': { input: { kind: EntityKind; entity: FlowEntity }; output: FlowState }
    'flow.deleteEntity': { input: { kind: EntityKind; id: string; workspaceId: string }; output: FlowState }
    'flow.openBoard': { input: { workspaceId: string }; output: { opened: boolean } }
    'flow.findStageChats': { input: { id: string; workspaceId: string; role: RoleKey }; output: StageChats }
    'flow.prepare': { input: PrepareInput; output: FlowState }
    /** Always rejects: trusted-worker has no supported sender identity. */
    'flow.launch': { input: PrepareInput; output: never }
    'flow.linkRun': { input: { id: string; itemId: string; workspaceId: string; confirm: boolean }; output: FlowState }
    'flow.acceptRun': { input: { id: string; workspaceId: string; confirm: boolean }; output: FlowState }
    'flow.archiveRun': { input: { id: string }; output: FlowState }
    'flow.refreshRun': { input: { id: string; nativeRunId?: string }; output: FlowState }
  }
  interface PluginPanelEvents { 'flow.changed': FlowState }
}
