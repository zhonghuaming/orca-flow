import { createHash } from 'node:crypto'
import { truncateUtf8 } from './flow-domain.mjs'

export const MAX_EVENTS = 40
export const MAX_EVENT_BYTES = 16 * 1024

/** Record transitions, not polls. Missing legacy history is intentionally not backfilled. */
export function event(run, kind, detail, key = detail) {
  const fingerprint = createHash('sha256').update(`${kind}:${key}`).digest('hex')
  const previous = run.events || []
  if (previous.at(-1)?.fingerprint === fingerprint) return run
  const entry = { kind, at: Date.now(), detail: truncateUtf8(detail, 240), fingerprint }
  const candidates = [...previous, entry].slice(-MAX_EVENTS)
  const events = candidates.filter((_, index) => Buffer.byteLength(JSON.stringify(candidates.slice(index)), 'utf8') <= MAX_EVENT_BYTES)
  return { ...run, events }
}

export function observed(run, next) {
  const signature = createHash('sha256').update(JSON.stringify({ status: next.status, nativeRunId: next.nativeRunId, tasks: next.tasks })).digest('hex')
  if (run.observation === signature) return { ...next, observation: signature }
  return event({ ...next, observation: signature }, next.status === 'blocked' ? 'blocked' : 'verified', `核对状态：${next.status}；Orca 执行记录 ID：${next.nativeRunId}`, signature)
}
