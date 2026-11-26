export type RoleKey = 'product' | 'architect' | 'developer' | 'tester'
export type EntityKind = 'items' | 'sprints' | 'epics' | 'workflows'
export interface FlowBot { id: string; name: string; agent: string; paused: boolean }
export interface Workspace { id: string; name: string; path: string; branch?: string | null; projectId?: string | null; hostId?: string | null }
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
export interface NativeTask { id: string; title: string; status: string; deps: string[] | null; result?: string }
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
  archived?: boolean
  archiveFile?: string
}
export interface FlowState {
  roles: Partial<Record<RoleKey, string>>
  bots: FlowBot[]
  sprints: FlowEntity[]
  epics: FlowEntity[]
  items: FlowEntity[]
  workflows: FlowEntity[]
  runs: FlowRun[]
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
    'flow.launch': { input: { id: string; title: string; goal: string; workspaceId: string }; output: FlowState }
    'flow.archiveRun': { input: { id: string }; output: FlowState }
    'flow.refreshRun': { input: { id: string; nativeRunId?: string }; output: FlowState }
  }
  interface PluginPanelEvents { 'flow.changed': FlowState }
}
