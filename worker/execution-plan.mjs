export const DEFAULT_SCOPE = '仅限冻结工作区内完成用户目标所必需、可逆的离线开发；不包含生产、数据破坏、凭据、发布或权限变更授权。'
export const EVIDENCE_PREFIX = 'FLOW_EVIDENCE_V1\n'
export const reworkTitle = (round) => `[Flow rework ${round}]`
export function parseEvidence(result) {
  if (typeof result !== 'string' || !result.startsWith(EVIDENCE_PREFIX)) return null
  try {
    const value = JSON.parse(result.slice(EVIDENCE_PREFIX.length))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}
export function validateEvidence(required, plan) {
  const records = required.map((task) => ({ task, evidence: parseEvidence(task.result) }))
  if (records.some(({ evidence }) => !evidence || typeof evidence.summary !== 'string' || !evidence.summary.trim() || typeof evidence.sourceVersion !== 'string' || !evidence.sourceVersion.trim())) return '所需阶段缺少可核对的源码版本与结果说明（记录格式：FLOW_EVIDENCE_V1）。'
  const implementation = records.filter(({ task }) => ['[Flow developer]', '[Flow tester]'].includes(task.title))
  if (implementation.some(({ evidence }) => !Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.some((check) => typeof check !== 'string' || !check.trim()))) return '开发/测试阶段必须记录适用检查、真实输出或明确跳过原因。'
  if (new Set(implementation.map(({ evidence }) => evidence.sourceVersion)).size !== 1) return '开发与测试的源码版本不一致，不能复用验证结果或确认验收。'
  if (plan.requiresIndependentReview && !records.some(({ task, evidence }) => task.title === '[Flow tester]' && evidence.independentReview === true)) return '复杂/敏感声明要求测试角色保留必要独立边界审查证据。'
  if (plan.mode === 'light' && implementation.some(({ evidence }) => evidence.requiresIndependentReview === true)) return '轻量路线发现必要独立审查缺口；需报告阻塞，不能以自验冒充独立审查。'
  return ''
}
export function summarizeRework(tasks, plan, required) {
  const markers = tasks.filter((task) => /^\[Flow rework \d+\]$/.test(task.title))
  const rounds = markers.length
  if (!rounds) return { rounds: 0 }
  if (rounds > plan.maxReworkRounds) return { rounds, status: 'blocked', message: '本次执行的返工次数已超过上限；不能通过新建执行记录重新计数。' }
  const developer = required.find((task) => task.title === '[Flow developer]')
  const verification = required.find((task) => task.title === '[Flow tester]') || developer
  for (let round = 1; round <= rounds; round++) {
    const matches = markers.filter((task) => task.title === reworkTitle(round))
    if (matches.length !== 1) return { rounds, status: 'review', message: '返工轮次缺失或重复，不能确认计数。' }
    const marker = matches[0]
    const evidence = parseEvidence(marker.result)
    if (!evidence || evidence.round !== round || evidence.kind !== 'reproducible-test-failure' || evidence.developerTaskId !== developer?.id || evidence.verificationTaskId !== verification?.id || !Array.isArray(marker.deps) || marker.deps.length || !['beforeRevision', 'reproduction'].every((key) => typeof evidence[key] === 'string' && evidence[key].trim())) return { rounds, status: 'review', message: '返工缺少确认失败、原任务 ID、复现或源码版本证据；外部操作结果未确认，请先核对，不自动重试。' }
    if (marker.status === 'failed' || marker.status === 'blocked') return { rounds, status: 'blocked', message: '返工已阻塞或失败，请查看本次执行的原因与证据。' }
    if (marker.status !== 'completed') return { rounds, status: 'running', message: `本次执行第 ${round}/${plan.maxReworkRounds} 轮返工中，尚不能确认完成。` }
    if (!['afterRevision', 'regression'].every((key) => typeof evidence[key] === 'string' && evidence[key].trim())) return { rounds, status: 'review', message: '返工缺少修复版本或定向回归证据。' }
  }
  const last = parseEvidence(markers.find((task) => task.title === reworkTitle(rounds)).result)
  if (parseEvidence(developer?.result)?.sourceVersion !== last.afterRevision || parseEvidence(verification?.result)?.sourceVersion !== last.afterRevision) return { rounds, status: 'review', message: '最终开发/验收版本与最后一轮修复版本不一致。' }
  return { rounds }
}
