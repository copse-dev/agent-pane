import { SHELL_DECISION_SUBJECT } from '@shared/threads/decision-log.ts'
import { getHookRunRecordingContext } from '../hook-run-recorder.ts'
import { recordDecision } from './decision-log-store.ts'

export type PermissionAuditInput = {
  originalCommand: string
  effectiveCommand?: string
  originalMode: 'guarded-yolo'
  effectiveMode: 'guarded-yolo'
  sandboxState: 'project-sandbox' | 'unsandboxed'
  harmDecision: 'allow' | 'prompt' | 'deny'
  policyDecision: 'allow' | 'prompt' | 'deny'
  reasons: string[]
  userResponse: 'approved' | 'declined' | 'not-required'
}

/**
 * Best-effort durable recording for Guarded YOLO shell authorizations. Writes a
 * unified spine `decision` line (with command text in a detail blob) rather than
 * the legacy `permission_decision` line shape.
 */
export function recordPermissionDecision(input: PermissionAuditInput): void {
  const context = getHookRunRecordingContext()
  const verdict =
    input.userResponse === 'approved'
      ? 'approved'
      : input.userResponse === 'declined'
        ? 'denied'
        : 'allowed'
  recordDecision({
    kind: 'shell',
    actor: input.userResponse === 'not-required' ? 'system' : 'user',
    verdict,
    subject: SHELL_DECISION_SUBJECT,
    scope: input.sandboxState === 'unsandboxed' ? 'external' : 'sandbox',
    reasons: input.reasons,
    cause: 'shell-guarded-yolo-harm',
    ...(context
      ? {
          projectId: context.projectId,
          threadId: context.threadId,
          turnId: context.turnId,
          step: context.step,
        }
      : {}),
    detail: {
      originalCommand: input.originalCommand,
      ...(input.effectiveCommand !== undefined ? { effectiveCommand: input.effectiveCommand } : {}),
      originalMode: input.originalMode,
      effectiveMode: input.effectiveMode,
      sandboxState: input.sandboxState,
      harmDecision: input.harmDecision,
      policyDecision: input.policyDecision,
      userResponse: input.userResponse,
    },
  })
}
