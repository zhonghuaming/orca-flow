import { defineCheck } from 'orca/testing'
const workspace = { id: 'check-workspace', kind: 'worktree' as const, name: '离线验收项目', path: 'E:/workspace/flow-demo', branch: 'main', projectId: 'check-project', hostId: 'local' }
const base = { roles: {}, bots: [], items: [], sprints: [], epics: [], workflows: [], runs: [] }
export default defineCheck({
  empty: {
    results: { 'workspace.list': { workspaces: [workspace], truncated: false }, 'workspace.readContext': { workspaceId: workspace.id, branch: workspace.branch, displayName: workspace.name, terminals: [] } },
    storage: { flow_native_v1: base }
  },
  populated: {
    results: { 'workspace.list': { workspaces: [workspace], truncated: false }, 'workspace.readContext': { workspaceId: workspace.id, branch: workspace.branch, displayName: workspace.name, terminals: [] } },
    storage: { flow_native_v1: {
      ...base,
      items: [
        { id: 'check-task-1', title: '完成原生四角色工作流的需求与验收标准', description: '产品、架构、开发和测试通过 Orca 原生任务交接；只有实际结果证据才能证明阶段完成。', workspaceId: workspace.id, status: 'in-review', points: 5 },
        { id: 'check-task-2', title: '保持用户自定义 English 内容原样', description: '这是离线场景数据，不调用真实 Bot，也不写入真实插件存储。', workspaceId: workspace.id, status: 'todo', points: 3 }
      ]
    } }
  }
})
