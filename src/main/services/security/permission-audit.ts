import { randomUUID } from 'node:crypto'
import {
  SPINE_SCHEMA_VERSION,
  type SpinePermissionDecisionLine,
} from '@shared/threads/spine-schema.ts'
import { getHookRunRecordingContext } from '../hook-run-recorder.ts'
import { appendPermissionDecision } from '../thread-store.ts'

export type PermissionAuditInput = Omit<
  SpinePermissionDecisionLine,
  'v' | 'type' | 'id' | 'turnId' | 'step' | 'decidedAt'
>

/**
 * Best-effort durable recording. Authorization never depends on observability:
 * an audit write failure warns after the host-owned decision has already been made.
 */
export function recordPermissionDecision(input: PermissionAuditInput): void {
  const context = getHookRunRecordingContext()
  if (!context) return
  const line: SpinePermissionDecisionLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'permission_decision',
    id: randomUUID(),
    turnId: context.turnId,
    step: context.step,
    decidedAt: Date.now(),
    ...input,
  }
  void appendPermissionDecision(context.projectId, context.threadId, line).catch(
    (error: unknown) => {
      console.warn('[permission-audit] failed to append permission_decision:', error)
    },
  )
}
