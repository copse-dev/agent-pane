import { randomUUID } from 'node:crypto'
import type { AppliedNudgeRecord } from '@copse/agent/run-agent-loop.ts'
import { SPINE_SCHEMA_VERSION, type SpineNudgeLine } from '@shared/threads/spine-schema.ts'
import { getHookRunRecordingContext } from './hook-run-recorder.ts'
import { appendNudge } from './thread-store.ts'

/**
 * Persist a model-visible loop steer beside the messages it affected. Recording
 * is best-effort observability and must never alter the agent run.
 */
export function recordAppliedNudge(record: AppliedNudgeRecord): void {
  const context = getHookRunRecordingContext()
  if (!context) return
  const line: SpineNudgeLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'nudge',
    id: randomUUID(),
    turnId: context.turnId,
    step: record.step,
    recordedAt: Date.now(),
    hookId: record.hookId,
    mechanism: record.mechanism,
    ...(record.cause !== undefined ? { cause: record.cause } : {}),
    text: record.text,
  }
  appendNudge(context.projectId, context.threadId, line).catch((error: unknown) => {
    console.warn('[nudge-recorder] failed to append nudge:', error)
  })
}
