/** Credential-free, bounded messages on one run's private stdio link. */
import { z } from 'zod'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  providerImageSchema as image,
  providerToolCallSchema as toolCall,
  providerStreamChunkSchema as chunk,
} from '@copse/llm/provider-stream-schema.ts'

export const HOST_INFERENCE_TARGET = 'inference.copse.internal:443'
export const INFERENCE_MESSAGE_LIMIT = 4 * 1024 * 1024
const message: z.ZodType<LLMMessage> = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('developer'), content: z.string() }),
  z.object({
    role: z.literal('user'),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          z.object({ type: z.literal('text'), text: z.string() }),
          z
            .object({
              type: z.literal('image'),
              dataUrl: z.string(),
              detail: z.enum(['auto', 'low', 'high']).optional(),
            })
            .transform(({ type, dataUrl, detail }) => ({
              type,
              dataUrl,
              ...(detail !== undefined ? { detail } : {}),
            })),
        ]),
      ),
    ]),
  }),
  z.object({ role: z.literal('assistant'), content: z.union([z.string(), z.array(toolCall)]) }),
  z.object({
    role: z.literal('tool'),
    toolResults: z.array(
      z
        .object({ toolCallId: z.string(), result: z.string(), images: z.array(image).optional() })
        .transform(({ toolCallId, result, images }) => ({
          toolCallId,
          result,
          ...(images !== undefined ? { images } : {}),
        })),
    ),
  }),
])
export const inferenceRequestSchema = z
  .object({
    messages: z.array(message).max(1024),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          parameters: z.record(z.string(), z.unknown()),
        }),
      )
      .max(256),
    options: z
      .object({
        toolChoice: z.object({ name: z.string() }).strict().optional(),
        suppressReasoning: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export const inferenceResponseSchema = z.union([
  z.object({ chunk }).strict(),
  z.object({ error: z.string() }).strict(),
  z.object({ end: z.literal(true) }).strict(),
])
