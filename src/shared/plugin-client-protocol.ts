import { z } from 'zod'
import { clientLabelSchema } from './client-auth.ts'
import { askUserQuestionSchema, ASK_USER_ANSWER_MAX_LENGTH } from '@copse/agent/ask-user-format.ts'

const id = z.string().regex(/^[\w-]{1,128}$/)
export const clientPairSchema = z.strictObject({
  version: z.literal(1),
  label: clientLabelSchema,
})
export const clientDecisionSchema = z.strictObject({
  version: z.literal(1),
  submissionId: z.uuid(),
  sessionId: z.uuid(),
  projectId: id,
  threadId: id,
  requestId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  approved: z.boolean(),
})
export const clientSnapshotSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  canRespond: z.boolean(),
  requests: z.array(
    z.strictObject({
      projectId: id,
      threadId: id,
      requestId: z.uuid(),
      revision: z.number().int().positive(),
      title: z.string(),
      body: z.string(),
      advice: z.string().optional(),
      footer: z.string().optional(),
    }),
  ),
})
export type ClientSnapshot = z.infer<typeof clientSnapshotSchema>

/** All waiting human requests, including those whose decision semantics need the desktop. */
export const clientAttentionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  requests: z
    .array(
      z.strictObject({
        projectId: id,
        threadId: id,
        requestId: z.uuid(),
        revision: z.number().int().positive(),
        kind: z.enum(['approval', 'question']),
        title: z.string().max(200),
        canRespond: z.boolean(),
      }),
    )
    .max(1000),
})

export const clientQuestionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  requests: z
    .array(
      z.strictObject({
        projectId: id,
        threadId: id,
        requestId: z.uuid(),
        revision: z.number().int().positive(),
        questions: z.array(askUserQuestionSchema).min(1).max(10),
      }),
    )
    .max(1000),
})
export const clientQuestionAnswerSchema = clientDecisionSchema.omit({ approved: true }).extend({
  answers: z.array(z.string().max(ASK_USER_ANSWER_MAX_LENGTH)).min(1).max(10),
})

/** Metadata only; never includes messages, paths, tool arguments or provider state. */
export const clientRecentThreadSchema = z.strictObject({
  projectId: id,
  projectName: z.string().max(200),
  threadId: id,
  title: z.string().max(200),
  state: z.enum(['finished', 'failed']),
  settledAt: z.number().int().nonnegative(),
})
export const clientActivityDataSchema = z.strictObject({
  recentThreads: z.array(clientRecentThreadSchema).max(20),
  runningCount: z.number().int().nonnegative(),
  waitingCount: z.number().int().nonnegative(),
})
export const clientActivitySnapshotSchema = clientActivityDataSchema.extend({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
})
export const clientOpenThreadSchema = z.strictObject({
  version: z.literal(1),
  projectId: id,
  threadId: id,
})
export type ClientActivityData = z.infer<typeof clientActivityDataSchema>
export type ClientActivitySnapshot = z.infer<typeof clientActivitySnapshotSchema>

/** On-demand text only; metadata polling never includes conversation content. */
export const clientReadThreadSchema = clientOpenThreadSchema.extend({
  settledAt: z.number().int().nonnegative(),
})
export const clientThreadTextSchema = z
  .strictObject({
    messages: z
      .array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string().max(24000) }))
      .max(8),
    truncated: z.boolean(),
  })
  .refine(
    (value) => value.messages.reduce((size, message) => size + message.text.length, 0) <= 24000,
  )
export const clientThreadContentSchema = clientReadThreadSchema
  .extend({
    sessionId: z.uuid(),
    messages: clientThreadTextSchema.shape.messages,
    truncated: z.boolean(),
  })
  .refine(
    (value) => value.messages.reduce((size, message) => size + message.text.length, 0) <= 24000,
  )
export type ClientThreadText = z.infer<typeof clientThreadTextSchema>
