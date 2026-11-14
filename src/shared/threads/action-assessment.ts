import { z } from 'zod'
import type { Thread } from '@shared/types/thread.ts'

export const threadActionVerdictSchema = z.object({
  status: z.enum(['needs-action', 'waiting', 'complete', 'uncertain']),
  reason: z.string().trim().min(1).max(240),
  evidence: z.array(z.string().max(120)).max(6),
})
export type ThreadActionVerdict = z.infer<typeof threadActionVerdictSchema>

export const threadActionAssessmentSchema = threadActionVerdictSchema.extend({
  revision: z.string().max(128),
  assessedAt: z.number(),
  source: z.enum(['judge', 'rules', 'interrupted']),
})
export type ThreadActionAssessment = z.infer<typeof threadActionAssessmentSchema>

export interface ThreadActionEntry {
  projectId: string
  threadId: string
  assessment: ThreadActionAssessment
}

/** Read-only, advisory signal. It grants no authority to continue a thread. */
export interface ThreadActionState {
  entries: ThreadActionEntry[]
  assessed: number
  total: number
  pending: number
  assessing: boolean
  budgetLimited: boolean
  unavailable?: boolean
}

/** Cheap scan revision. Metadata-only changes are deduplicated by the full evidence hash before inference. */
export function threadActionRevision(thread: Partial<Thread>): string {
  return JSON.stringify([
    thread.updatedAt,
    thread.lastPromptAt,
    thread.lastSettledAt,
    thread.interruptedTurnAt,
    thread.status,
    thread.todos,
    thread.prProductions,
    thread.commitProductions,
    thread.remoteAgentLink,
    thread.usage,
  ])
}

export function emptyThreadActionState(): ThreadActionState {
  return { entries: [], assessed: 0, total: 0, pending: 0, assessing: false, budgetLimited: false }
}
