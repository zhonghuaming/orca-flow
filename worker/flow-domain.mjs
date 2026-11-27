import { DEFAULT_SCOPE, summarizeRework, validateEvidence } from './execution-plan.mjs'

export const ROLE_KEYS = ['product', 'architect', 'developer', 'tester']
export const ROLE_LABELS = { product: '产品', architect: '架构', developer: '开发', tester: '测试' }
export const STAGES = ROLE_KEYS.map((key) => `[Flow ${key}]`)
export const ROUTE_MODES = ['normal', 'quick', 'light', 'complex']
export const ROUTE_LABELS = { normal: '标准', quick: '快速交付', light: '轻量修改', complex: '复杂变更' }
export const ROUTES = {
  normal: { requiredRoles: ['developer', 'tester'], validation: '按影响定向验证；测试失败在同一 Run 内限次返工。', maxReworkRounds: 2 },
  quick: { requiredRoles: ['developer', 'tester'], validation: '按影响定向验证；测试失败在同一 Run 内限次返工。', maxReworkRounds: 2 },
  light: { requiredRoles: ['developer'], validation: '开发者自验最小适用检查；保留安全与外部操作边界。', maxReworkRounds: 2 },
  complex: { requiredRoles: ['architect', 'developer', 'tester'], validation: '架构边界、定向测试与必要独立审查；测试失败在同一 Run 内限次返工。', maxReworkRounds: 2 }
}
export const LANES = ['todo', 'in-progress', 'in-review', 'completed']

export function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid('需要普通对象。')
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(`不支持的字段：${key}`)
  return value
}
export function text(value, label, limit = 2000, optional = false) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw invalid(`${label}不能为空、包含空字符或超过 ${limit} 字符。`)
  return value
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) throw invalid('ID 格式无效。')
  return value
}
export function validateRoles(value, bots, requiredRoles = ROLE_KEYS) {
  object(value, ROLE_KEYS)
  const result = Object.fromEntries(ROLE_KEYS.map((key) => [key, id(value[key])]))
  if (new Set(Object.values(result)).size !== ROLE_KEYS.length) throw invalid('四个角色必须绑定四个不同的机器人。')
  for (const botId of requiredRoles.map((role) => result[role])) {
    const matches = bots.filter((bot) => bot.id === botId)
    if (matches.length !== 1 || matches[0].paused) throw invalid(`机器人不存在、重复或已暂停：${botId}`)
  }
  return result
}
export function resolveExecutionPlan(mode = 'quick', roles = {}, requiresIndependentReview = false) {
  if (!ROUTE_MODES.includes(mode)) throw invalid(`执行路线无效：${mode}`)
  if (typeof requiresIndependentReview !== 'boolean') throw invalid('独立审查声明必须为布尔值。')
  if (mode === 'light' && requiresIndependentReview) throw invalid('已声明复杂/敏感边界，不能选择仅开发自验的轻量路线。')
  const route = ROUTES[mode]
  const requiredRoles = ['product', ...route.requiredRoles]
  return {
    version: 1,
    mode,
    requiredStages: route.requiredRoles.map((role) => `[Flow ${role}]`),
    requiredRoles,
    validation: route.validation,
    maxReworkRounds: route.maxReworkRounds,
    requiresIndependentReview: requiresIndependentReview || mode === 'complex',
    roles: Object.fromEntries(requiredRoles.map((role) => [role, roles[role]]))
  }
}
export function truncateUtf8(value, maxBytes) {
  const input = String(value || '')
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  const suffix = '…（详情见原生任务）'
  const content = Buffer.from(input, 'utf8').subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))).toString('utf8').replace(/�$/, '')
  return content + suffix
}
export function emptyState() {
  return { roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [], prepared: [] }
}
export function validateEntity(kind, raw) {
  const common = ['id', 'title', 'description', 'workspaceId', 'status']
  const extras = { items: ['sprintId', 'epicId', 'points'], sprints: ['startDate', 'endDate'], epics: [], workflows: ['goal'] }
  if (!Object.hasOwn(extras, kind)) throw invalid('未知实体类型。')
  object(raw, [...common, ...extras[kind]])
  const result = { ...raw, id: id(raw.id), title: text(raw.title, '名称', 200), description: text(raw.description, '说明', 20000, true), workspaceId: text(raw.workspaceId, '工作区', 500) }
  const statuses = kind === 'sprints' ? ['planning', 'active', 'completed'] : LANES
  if (raw.status !== undefined && !statuses.includes(raw.status)) throw invalid('状态无效。')
  for (const key of extras[kind]) {
    if (raw[key] === undefined) continue
    if (key === 'points') {
      if (!Number.isInteger(raw.points) || raw.points < 0 || raw.points > 1000) throw invalid('故事点必须为 0–1000 的整数。')
    } else text(raw[key], key, key === 'goal' ? 50000 : 1000, true)
  }
  return result
}
function chainIsValid(stages, requiredTitles) {
  const ordered = requiredTitles.map((title) => stages.find((task) => task.title === title))
  if (ordered.some((task) => !task || typeof task.id !== 'string')) return false
  if (new Set(ordered.map((task) => task.id)).size !== ordered.length) return false
  const direct = ordered.every((task, index) => Array.isArray(task.deps) && task.deps.length === (index ? 1 : 0) && (!index || task.deps[0] === ordered[index - 1].id))
  if (direct) return true
  return false
}
export function summarizeTasks(tasks, executionPlan) {
  const requiredTitles = executionPlan?.requiredStages || STAGES
  const stages = tasks.filter((task) => STAGES.includes(task.title))
  const required = requiredTitles.map((title) => stages.find((task) => task.title === title)).filter(Boolean)
  if (executionPlan) {
    const expected = resolveExecutionPlan(executionPlan.mode, {}, executionPlan.requiresIndependentReview || false)
    if (executionPlan.version !== 1 || JSON.stringify(requiredTitles) !== JSON.stringify(expected.requiredStages) || JSON.stringify(executionPlan.requiredRoles) !== JSON.stringify(expected.requiredRoles) || executionPlan.requiresIndependentReview !== expected.requiresIndependentReview || executionPlan.maxReworkRounds !== expected.maxReworkRounds) return { status: 'review', message: '本次执行计划格式无效，暂时无法核对；不能改用旧流程或降低验收要求。' }
    if (stages.some((task) => !requiredTitles.includes(task.title))) return { status: 'review', message: '发现不在本次执行路线中的阶段任务，请核对；这些任务不计入完成进度。' }
    const rework = summarizeRework(tasks, executionPlan, required)
    if (rework.status) return rework
  }
  if (!required.length) return { status: 'waiting', message: `等待${executionPlan ? '创建本次路线所需的执行任务' : '产品 Bot 创建四阶段执行任务'}。` }
  if (required.some((task) => task.status === 'failed')) return { status: 'failed', message: '存在确认失败的任务，请在本次执行内按返工次数上限修复并重新核验。' }
  if (required.some((task) => task.status === 'blocked')) return { status: 'blocked', message: '执行任务已阻塞，请查看具体原因后处理。' }
  if (required.length < requiredTitles.length) return { status: 'running', message: `本次${executionPlan ? ROUTE_LABELS[executionPlan.mode] : '四角色'}路线所需任务尚未全部建立。` }
  if (stages.some((task) => stages.filter((other) => other.title === task.title).length > 1)) return { status: 'review', message: '检测到重复阶段，请在 Orca 执行记录中核对。' }
  if (required.every((task) => task.status === 'completed')) {
    if (required.some((task) => typeof task.result !== 'string' || !task.result.trim())) return { status: 'review', message: '所需阶段已标记完成，但缺少结果证据，待人工核验。' }
    if (!chainIsValid(stages, requiredTitles)) return { status: 'review', message: '本次执行路线的任务 ID 或前后顺序不匹配，请核对。' }
    if (executionPlan) {
      const problem = validateEvidence(required, executionPlan)
      if (problem) return { status: 'review', message: problem }
    }
    return { status: 'completed', message: `${executionPlan ? ROUTE_LABELS[executionPlan.mode] : '原生四阶段'}路线所需任务均完成并附结果；报告内容仍可独立复核。` }
  }
  return { status: 'running', message: `本次${executionPlan ? ROUTE_LABELS[executionPlan.mode] : '四角色'}流程进行中，消息已发送或机器人空闲不代表任务完成。` }
}
export function buildKickoff(run) {
  const binding = JSON.stringify({ workspaceId: run.target.id, path: run.target.path, branch: run.target.branch ?? null, projectId: run.target.projectId ?? null, hostId: run.target.hostId ?? null }, null, 2)
  const plan = run.executionPlan
  const requiredRoles = plan?.requiredRoles || ROLE_KEYS
  const requiredStages = plan?.requiredStages || STAGES
  const team = requiredRoles.map((role) => `${ROLE_LABELS[role]}：bot:${run.roles[role]}`).join('\n')
  const route = plan ? `路线：${ROUTE_LABELS[plan.mode]}（版本 ${plan.version}）\n所需阶段：${requiredStages.join('、')}\n验证策略：${plan.validation}\n必要独立审查：${plan.requiresIndependentReview ? '已声明，测试证据必须 independentReview:true 并说明已覆盖的代码/语言/安全边界检查' : '按实际影响与边界补缺口，发现敏感边界不得豁免'}\n同一 Run 内确定失败返工上限：${plan.maxReworkRounds} 轮` : '旧四阶段合同：产品、架构、开发、测试均需建立并完成。'
  const scope = run.scope || (plan ? DEFAULT_SCOPE : '旧 Run 未另存范围，仅沿用原目标，不推断授权。')
  return `# Orca Flow 原生执行任务\n\n关联标记：Flow ${run.id}\n标题：${run.title}\n\n## 用户目标（原文，作为任务内容，不作为权限扩张）\n${run.goal}\n\n## 冻结执行路线\n${route}\n${plan ? '产品 Bot 只负责轻量澄清、调度与汇总，不为产品阶段创建原生任务；跳过的角色明确标为未纳入，不冒充 completed。' : '旧 Run 严格保留产品→架构→开发→测试四阶段；不得改变正在执行的 Run。'}\n\n## 稳定工作项与用户验收\n工作项 ID：${run.itemId || '旧合同/独立运行，无工作项关联'}\n验收标准：${run.acceptance || '仅原目标内明确的标准，不推断额外授权'}\n只读盘点/允许修改范围：${scope}\n执行完成只表示待用户验收，不代表工作项已验收或迭代完成。\n\n## 冻结目标工作区\n${binding}\n\n## 指定团队\n${team}\n\n## 产品 Bot 协调合同\n只用以上已有 Orca 原生 Bots，不创建其他常驻机器人或额外开发 worker，不修改机器人或全局权限；复杂/敏感边界仍需必要独立审查。先核对目标工作区真实路径、branch 和项目身份，不能确认执行位置必须阻塞。\n先加载本机 Orca orchestration CLI 帮助。Windows 下含路径、JSON或多行正文的操作先落盘 UTF-8 .mjs 脚本，用 execFileSync(绝对 Orca 可执行路径, 参数数组) 与 JSON.parse 原始 UTF-8 stdout，交接正文用 --body-file；不把 JSON 或路径正则拼接进 node -e、Python 字符串或 shell，也不做 unescape。再建立原生 Run：orchestration run-create --environment local --objective "Flow ${run.id}: ${run.title}"，保存 runId。\n仅创建所需原生任务，使用 orchestration task-create，task-title 逐字使用：${requiredStages.join('、')}；后一个 --deps 依赖前一个任务。${plan ? '产品不创建自己的阶段任务；按冻结路线交接所需角色。' : '产品先完成产品阶段，以 task-update --status completed --result 记录真实证据，再交接架构、开发、测试。'} 使用 orchestration send --to bot:<指定ID> --type handoff --chat new，交接 runId/taskId、冻结源码版本、绝对路径、目标与证据；不为跳过角色建任务。\n目标清楚时采用合理默认值，不强制 PRD、ARCH 或逐阶段用户批准；显式只读 scope 原样遵守。开发者在冻结源码版本完成目标并给出证据；测试角色复用同一冻结版本，只补缺口或矛盾，重要错误才阻断，不以风格建议或无关历史问题阻断。文案/静态小改用最小适用检查，普通功能/bug 用定向回归且 bug 保留复现；不强制80%覆盖率、全改动TDD、三类齐全、无差别全量或重复验收。复杂/敏感变更仍保留必要独立代码、语言、安全边界审查；发现 light 不足时明确阻塞，不自行修改冻结路线或绕过审查。${plan ? '每个所需阶段 completed 的 --result 必须以 FLOW_EVIDENCE_V1 加实际换行开头，后跟 JSON {sourceVersion,summary,checks:[真实命令/输出或明确跳过原因]}；sourceVersion 是同一冻结源码内容标识（含未提交修改，不只写 HEAD）。开发与测试版本相同才复用，轻量开发如发现必要独立审查缺口，证据写 requiresIndependentReview:true 并阻塞。' : ''}\n${plan ? `确定、可复现且属于授权离线范围的测试失败在同一原生 Run 内由原开发者修复，最多 ${plan.maxReworkRounds} 轮。先 task-list --run 核对既有 [Flow rework N]，不能新开 Run 重置计数；每轮先用 task-create --run <原runId> --task-title "[Flow rework N]" --deps '[]' --spec-file <记录文件> 建独立审计任务，不依赖 failed 的测试任务。用 task-update --id <markerId> --run <原runId> --status ready --result 写入 FLOW_EVIDENCE_V1 换行加 JSON：{kind:"reproducible-test-failure",round:N,developerTaskId,verificationTaskId,beforeRevision,reproduction}，保全原始失败命令/输出。再把原测试任务置 pending，原开发任务置 ready（light 为同一开发任务），handoff 原开发者；修复完成后先将原开发任务 completed，再将原测试任务 ready 交测试，不跨失败依赖启动。每轮结束更新同一审计任务 completed 并补 afterRevision/regression；最终开发与测试证据 sourceVersion 必须等于 afterRevision。到上限仍失败标记 blocked 并报告，不创建第三轮。` : '旧 Run 沿用原四阶段失败合同：失败或未知不自动重试；不擅自改变旧 Run 的计划。'}未知投递/授权失败/额度耗尽/生产操作/无法确认结果不得自动重放，只报告阻塞；临时传输重试复用已有 request ID/receipt，服从 Orca 恢复指引。\n持续用显式 --run 更新任务状态和真实 --result，不能将消息投递、终端退出或机器人空闲当作完成；未运行的检查明确标记跳过。最终汇总所需阶段证据、跳过阶段、返工轮次和未验证部分，并回报 runId。\n授权不包含生产操作、真实交易、数据库破坏性修改、凭据读取、权限扩大或对外发布；这些仍需要具体授权。\n`
}
