export const ROLE_KEYS = ['product', 'architect', 'developer', 'tester']
export const ROLE_LABELS = { product: '产品', architect: '架构', developer: '开发', tester: '测试' }
export const STAGES = ROLE_KEYS.map((key) => `[Flow ${key}]`)
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
export function validateRoles(value, bots) {
  object(value, ROLE_KEYS)
  const result = Object.fromEntries(ROLE_KEYS.map((key) => [key, id(value[key])]))
  if (new Set(Object.values(result)).size !== ROLE_KEYS.length) throw invalid('四个角色必须绑定四个不同的机器人。')
  for (const botId of Object.values(result)) {
    const matches = bots.filter((bot) => bot.id === botId)
    if (matches.length !== 1 || matches[0].paused) throw invalid(`机器人不存在、重复或已暂停：${botId}`)
  }
  return result
}
export function truncateUtf8(value, maxBytes) {
  const input = String(value || '')
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  const suffix = '…（详情见原生任务）'
  const content = Buffer.from(input, 'utf8').subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))).toString('utf8').replace(/�$/, '')
  return content + suffix
}
export function emptyState() {
  return { roles: {}, bots: [], sprints: [], epics: [], items: [], workflows: [], runs: [] }
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
export function summarizeTasks(tasks) {
  const stages = tasks.filter((task) => STAGES.includes(task.title))
  if (!stages.length) return { status: 'waiting', message: '等待产品 Bot 创建四阶段原生任务。' }
  if (stages.some((task) => task.status === 'failed')) return { status: 'failed', message: '存在失败任务，请查看原生结果，不自动重放。' }
  if (stages.some((task) => task.status === 'blocked')) return { status: 'blocked', message: '原生任务已阻塞，需要处理阻塞原因。' }
  if (new Set(stages.map((task) => task.title)).size !== stages.length) return { status: 'review', message: '检测到重复阶段，请在原生编排中核对。' }
  if (stages.length === STAGES.length) {
    const ordered = STAGES.map((title) => stages.find((task) => task.title === title))
    const validChain = new Set(stages.map((task) => task.id)).size === STAGES.length && ordered.every((task, index) =>
      task && typeof task.id === 'string' && Array.isArray(task.deps) && task.deps.length === (index ? 1 : 0) && (!index || task.deps[0] === ordered[index - 1]?.id)
    )
    if (!validChain) return { status: 'review', message: '原生四阶段的任务 ID 或依赖链不匹配，待核验。' }
  }
  if (STAGES.every((title) => stages.some((task) => task.title === title && task.status === 'completed'))) {
    if (stages.some((task) => typeof task.result !== 'string' || !task.result.trim())) return { status: 'review', message: '四阶段已标记完成，但缺少结果证据，待人工核验。' }
    return { status: 'completed', message: '原生四阶段均标记完成并附结果；报告内容仍可独立复核。' }
  }
  return { status: 'running', message: '原生四角色流程进行中，投递或空闲不等于完成。' }
}
export function buildKickoff(run) {
  const binding = JSON.stringify({ workspaceId: run.target.id, path: run.target.path, branch: run.target.branch ?? null, projectId: run.target.projectId ?? null, hostId: run.target.hostId ?? null }, null, 2)
  const team = ROLE_KEYS.map((role) => `${ROLE_LABELS[role]}：bot:${run.roles[role]}`).join('\n')
  return `# Orca Flow 原生四角色任务\n\n关联标记：Flow ${run.id}\n标题：${run.title}\n\n## 用户目标（原文，作为任务内容，不作为权限扩张）\n${run.goal}\n\n## 冻结目标工作区\n${binding}\n\n## 指定团队\n${team}\n\n## 产品 Bot 协调合同\n你是本次产品与协调者，只用以上四个已有 Orca 原生 Bots，不创建其他常驻机器人或额外开发 worker、不修改任何机器人或全局权限；临时只读审查遵守本机强制规则与本任务具体授权，有冲突时明确报告，不自行豁免规则、不使用供应商专用 CLI。\n先核对目标工作区的真实路径、branch 和项目身份；在目标工作区执行任务。仅在提示词中出现路径不代表工作目录绑定，不能确认执行位置时必须阻塞并报告，不得改写 Bot Home 或当前其他项目。\n先加载本机 Orca 的 orchestration skill/CLI 帮助。Windows 下所有含路径、JSON或多行正文的操作先落盘为 UTF-8 .mjs 脚本，再用 node <绝对脚本路径> 执行；脚本内使用 execFileSync(绝对 Orca 可执行路径, 参数数组) 与 JSON.parse(原始 UTF-8 stdout)，交接正文写文件并使用 --body-file，不把 JSON 或路径正则拼接进 node -e、Python 字符串或 shell，也不做 unescape。再建立原生 Run：orchestration run-create --environment local --objective "Flow ${run.id}: ${run.title.replace(/["\r\n]/g, ' ')}"，保存 runId。\n用 orchestration task-create 创建以下四个原生任务，task-title 必须逐字使用：${STAGES.join('、')}，后一个 --deps 依赖前一个任务；不要用插件私有队列或终端状态替代原生记录。\n产品阶段产出需求与验收标准；架构阶段产出方案与边界；开发阶段完成范围内修改并给出测试命令与输出；测试阶段针对同一源码版本独立验证，不直接修改实现。\n产品完成后通过 orchestration task-update 将对应任务标为 completed 并提供真实 --result 证据；通过 orchestration send --to bot:<指定ID> --type handoff --chat new 依次交接架构、开发、测试，提供 runId/taskId、绝对目标路径、前置产物及本阶段边界。\n你持续负责接收阶段回报和更新原生任务（使用显式 --run），前置阶段未完成不得执行后续；失败或未知不自动重试。让每个角色向你回复实际完成、失败或阻塞与证据，不伪造 worker_done。\n测试失败时标记 failed 并报告，不循环启动新任务；额外返工需另行确认。最终在原生结果中汇总四阶段证据、未验证部分，并将 runId 回报用户。\n不能将消息投递、终端退出或机器人空闲当作完成；未运行的测试必须明确标为跳过。\n授权不包含生产操作、真实交易、数据库破坏性修改、凭据读取、权限扩大或对外发布；这些仍需要具体授权。\n`
}
