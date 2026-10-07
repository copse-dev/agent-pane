import { CLASSIFIER_CALL_KIND, type ClassifierSubject } from '@shared/usage/classifier-use.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { getActiveProjectId } from '../workspace.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { recordDecision } from './decision-log-store.ts'

/** What one screening attempt did, as the footer's classifier section reports it. */
export interface ClassifierCall {
  subject: ClassifierSubject
  /** The model or classifier connection that was asked. */
  engine: string
  /** What it answered, e.g. `sandbox`; null when it gave no usable verdict. */
  verdictLabel: string | null
  confidence?: number
  latencyMs: number
  usage?: { inputTokens: number; outputTokens: number } | undefined
  /** The attempt ran out of its screening budget. */
  timedOut?: boolean
  /** Resolve these now when the answer may arrive after another run is active. */
  threadId?: string
  projectId?: string
}

function wholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/**
 * Record one screening attempt on the active thread's decision log, as a
 * `classifier-call` line. Best-effort like every decision: a thread-less call
 * (no active run) is dropped silently rather than warned about, since a
 * classifier can be asked outside any thread.
 */
export function recordClassifierCall(call: ClassifierCall): void {
  const context = currentThreadExecutionContext()
  const threadId = call.threadId ?? context?.threadId ?? getActiveRunThread()
  // A supplied thread must not borrow the project of an unrelated active run.
  const projectId =
    call.projectId ??
    (context?.threadId === threadId
      ? context.projectId
      : call.threadId === undefined
        ? getActiveProjectId()
        : undefined)
  if (!threadId || !projectId) return
  recordDecision({
    kind: CLASSIFIER_CALL_KIND,
    actor: 'classifier',
    verdict: call.verdictLabel !== null ? 'classified' : call.timedOut ? 'timeout' : 'ask',
    subject: call.subject,
    source: call.engine,
    latencyMs: wholeNumber(call.latencyMs),
    threadId,
    projectId,
    ...(call.verdictLabel !== null ? { scope: call.verdictLabel } : {}),
    ...(call.confidence !== undefined
      ? { confidence: Math.min(1, Math.max(0, call.confidence)) }
      : {}),
    ...(call.usage
      ? {
          inputTokens: wholeNumber(call.usage.inputTokens),
          outputTokens: wholeNumber(call.usage.outputTokens),
        }
      : {}),
  })
}
