import type { Workspace } from './protocol'

function displayPath(workspace: Workspace): string {
  return workspace.path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Display context only: the native workspace ID and target path remain untouched. */
export function buildWorkspaceOptions(workspaces: readonly Workspace[]) {
  const labels = workspaces.map((workspace) => {
    const project = workspace.projectName?.trim() || displayPath(workspace).split('/').pop() || workspace.name
    const parts = [project, workspace.name, workspace.branch || '']
    return parts.filter((part, index) => part && parts.indexOf(part) === index).join(' · ')
  })
  const qualified = labels.map((label, index) => {
    if (labels.indexOf(label) === labels.lastIndexOf(label)) return label
    const workspace = workspaces[index]!
    const host = workspace.hostId && workspace.hostId !== 'local' ? ` · ${workspace.hostId}` : ''
    return `${label} — ${displayPath(workspace)}${host}`
  })
  return workspaces.map((workspace, index) => {
    const label = qualified[index]!
    return {
      label: qualified.indexOf(label) === qualified.lastIndexOf(label) ? label : `${label} [${workspace.id}]`,
      value: workspace.id
    }
  })
}
