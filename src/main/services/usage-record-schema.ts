import { z } from 'zod'
import type { UsageRecordInput } from '@shared/usage/usage-event.ts'

export const usageRecordSchema = z.object({
  model: z.string().min(1).max(256),
  source: z.enum(['agent', 'small-tasks', 'safety-classifier']),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheCreationTokens: z.number().int().min(0).optional(),
  projectId: z.string().min(1).max(128).optional(),
  threadId: z.string().min(1).max(128).optional(),
  at: z.number().optional(),
})

export function parseUsageRecordInput(raw: unknown): UsageRecordInput {
  const parsed = usageRecordSchema.parse(raw)
  return {
    model: parsed.model,
    source: parsed.source,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    ...(parsed.cacheReadTokens !== undefined ? { cacheReadTokens: parsed.cacheReadTokens } : {}),
    ...(parsed.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: parsed.cacheCreationTokens }
      : {}),
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
    ...(parsed.at !== undefined ? { at: parsed.at } : {}),
  }
}
