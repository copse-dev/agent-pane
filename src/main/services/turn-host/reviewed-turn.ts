import { z } from 'zod'
import { userContentSchema } from '@copse/agent/parse-agent-run-payload.ts'
import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'
import { planStateSchema, type StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import type { TranscriptAttachment } from '@shared/types'
import { llmMessageSchema } from '../container-runtime/host-inference-wire.ts'

/**
 * What main decided about a human prompt before it hands the turn to the
 * resident host: the text the human approved in protected review, the
 * provider history and plan frozen before that review, and the optimistic
 * bubble main proved the window appended. The host runs exactly this; it never
 * reviews, and it runs no human prompt without it.
 */
export interface ReviewedTurn {
  /** The prompt the human approved, which replaces the payload's own content. */
  content: UserContent
  history: LLMMessage[]
  plan: StoredThreadPlan | null
  /** Main claimed this bubble's one-use append receipt, so acceptance may keep it. */
  optimisticMessageId?: string | undefined
  /** Review made no text edit, so the window keeps the bubble it shows. */
  preserveOptimisticDisplay?: true | undefined
  attachments?: TranscriptAttachment[] | undefined
}

const id = z.string().min(1).max(256)

const attachmentSchema = z
  .object({
    kind: z.enum(['paste', 'file', 'thread', 'shell', 'video', 'archive']),
    label: z.string().max(1_024),
    placement: z.literal('inline').optional(),
    projection: z.enum(['canonical-block', 'canonical-thread-label']).optional(),
    content: z.string().optional(),
    path: z.string().max(16_384).optional(),
  })
  .transform(({ kind, label, placement, projection, content, path }): TranscriptAttachment => ({
    kind,
    label,
    ...(placement !== undefined ? { placement } : {}),
    ...(projection !== undefined ? { projection } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(path !== undefined ? { path } : {}),
  }))

const storedPlanSchema = planStateSchema
  .extend({ body: z.string(), contentHash: z.string() })
  .transform((plan): StoredThreadPlan => plan)

export const reviewedTurnSchema = z
  .object({
    content: userContentSchema,
    history: z.array(llmMessageSchema),
    plan: storedPlanSchema.nullable(),
    optimisticMessageId: id.optional(),
    preserveOptimisticDisplay: z.literal(true).optional(),
    attachments: z.array(attachmentSchema).max(64).optional(),
  })
  .transform(
    ({
      content,
      history,
      plan,
      optimisticMessageId,
      preserveOptimisticDisplay,
      attachments,
    }): ReviewedTurn => ({
      content,
      history,
      plan,
      ...(optimisticMessageId !== undefined ? { optimisticMessageId } : {}),
      ...(preserveOptimisticDisplay !== undefined ? { preserveOptimisticDisplay } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    }),
  )
