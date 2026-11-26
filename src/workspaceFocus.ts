import type { FlowState, Workspace } from './protocol'

export type WorkspaceFocus = { workspaceId?: string; branch?: string; displayName?: string }

/** A late initial read must not roll back metadata or business broadcasts from newer events. */
export function mergeInitialSnapshot(initial: FlowState, latest: FlowState, contextChanged: boolean, businessChanged: boolean): FlowState {
  return {
    ...(businessChanged ? latest : initial),
    workspaces: contextChanged ? latest.workspaces : initial.workspaces ?? latest.workspaces
  }
}

function normalizedPath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

/** Never identify a target by branch/display name: both can repeat across projects. */
export function resolveFocusedWorkspaceId(context: WorkspaceFocus | null, workspaces: readonly Workspace[]): string {
  const current = context?.workspaceId
  if (!current) return ''
  const exact = workspaces.filter((workspace) => workspace.id === current)
  if (exact.length === 1) return exact[0]!.id
  const separator = current.indexOf('::')
  if (separator < 0) return ''
  const projectId = current.slice(0, separator)
  const path = normalizedPath(current.slice(separator + 2))
  const matches = workspaces.filter((workspace) => workspace.projectId === projectId && normalizedPath(workspace.path) === path)
  return matches.length === 1 ? matches[0]!.id : ''
}
