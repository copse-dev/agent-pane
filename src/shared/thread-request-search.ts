import { z } from 'zod'

export const requestSearchCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search'),
    id: z.number().int(),
    projectId: z.string(),
    query: z.string(),
  }),
  z.object({ kind: z.literal('refresh'), id: z.number().int(), projectId: z.string() }),
  z.object({ kind: z.literal('cancel'), id: z.number().int() }),
])
export type RequestSearchCommand = z.infer<typeof requestSearchCommandSchema>
export const requestSearchReplySchema = z.object({
  id: z.number().int(),
  matches: z.array(z.string()),
  incomplete: z.boolean(),
  error: z.string().optional(),
})
export type RequestSearchReply = z.infer<typeof requestSearchReplySchema>
