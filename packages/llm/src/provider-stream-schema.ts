import { z } from 'zod'
import type { ProviderStreamChunk } from './wire-types.ts'
import { SERVICE_TIERS } from './service-tier.ts'

export const providerImageSchema = z
  .object({
    dataUrl: z.string(),
    name: z.string().optional(),
    kind: z.enum(['screenshot', 'frames']).optional(),
  })
  .transform(({ dataUrl, name, kind }) => ({
    dataUrl,
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
  }))
export const providerToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    args: z.unknown(),
    argsError: z.string().optional(),
    kind: z.string().optional(),
  })
  .transform(({ id, name, args, argsError, kind }) => ({
    id,
    name,
    args,
    ...(argsError !== undefined ? { argsError } : {}),
    ...(kind !== undefined ? { kind } : {}),
  }))
/** Opaque server-side compaction state a provider emits and later replays. */
export const providerCompactionStateSchema = z.object({
  kind: z.literal('openai-responses-compaction'),
  v: z.literal(1),
  model: z.string().min(1),
  endpoint: z.string(),
  itemId: z.string().min(1),
  encryptedContent: z.string().min(1),
})
const tokenFields = {
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
}
const tokens = z
  .object(tokenFields)
  .transform(({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) => ({
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  }))
export const providerStreamChunkSchema: z.ZodType<ProviderStreamChunk> = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), toolCall: providerToolCallSchema }),
  z
    .object({
      type: z.literal('tool_result'),
      toolCallId: z.string(),
      result: z.string(),
      isError: z.boolean(),
      editStats: z.object({ additions: z.number(), deletions: z.number() }).optional(),
      resultFormat: z.literal('markdown').optional(),
      appendedReminderLengths: z.array(z.number()).optional(),
      images: z.array(providerImageSchema).optional(),
    })
    .transform(
      ({
        type,
        toolCallId,
        result,
        isError,
        editStats,
        resultFormat,
        appendedReminderLengths,
        images,
      }) => ({
        type,
        toolCallId,
        result,
        isError,
        ...(editStats !== undefined ? { editStats } : {}),
        ...(resultFormat !== undefined ? { resultFormat } : {}),
        ...(appendedReminderLengths !== undefined ? { appendedReminderLengths } : {}),
        ...(images !== undefined ? { images } : {}),
      }),
    ),
  z
    .object({
      ...tokenFields,
      type: z.literal('usage'),
      model: z.string(),
      hostingProvider: z.string().optional(),
      requestedServiceTier: z.enum(SERVICE_TIERS).optional(),
      responseServiceTier: z.enum(SERVICE_TIERS).optional(),
      serviceTierUsage: z
        .object({ flex: tokens.optional(), priority: tokens.optional(), scale: tokens.optional() })
        .transform(({ flex, priority, scale }) => ({
          ...(flex ? { flex } : {}),
          ...(priority ? { priority } : {}),
          ...(scale ? { scale } : {}),
        }))
        .optional(),
      estimated: z.boolean().optional(),
      usageSource: z.literal('advisor').optional(),
      subagentUsage: z.literal(true).optional(),
    })
    .transform(
      ({
        type,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        hostingProvider,
        requestedServiceTier,
        responseServiceTier,
        serviceTierUsage,
        estimated,
        usageSource,
        subagentUsage,
      }) => ({
        type,
        model,
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        ...(hostingProvider !== undefined ? { hostingProvider } : {}),
        ...(requestedServiceTier !== undefined ? { requestedServiceTier } : {}),
        ...(responseServiceTier !== undefined ? { responseServiceTier } : {}),
        ...(serviceTierUsage !== undefined ? { serviceTierUsage } : {}),
        ...(estimated !== undefined ? { estimated } : {}),
        ...(usageSource !== undefined ? { usageSource } : {}),
        ...(subagentUsage !== undefined ? { subagentUsage } : {}),
      }),
    ),
  z.object({ type: z.literal('prompt_progress'), fraction: z.number().min(0).max(1) }),
  z.object({ type: z.literal('provider_state'), state: providerCompactionStateSchema }),
  z
    .object({
      type: z.literal('done'),
      stopReason: z.string().optional(),
      malformedToolCall: z
        .object({
          message: z.string(),
          hitOutputCeiling: z.boolean(),
          outputTokens: z.number().optional(),
        })
        .transform(({ message, hitOutputCeiling, outputTokens }) => ({
          message,
          hitOutputCeiling,
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        }))
        .optional(),
    })
    .transform(({ type, stopReason, malformedToolCall }) => ({
      type,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(malformedToolCall !== undefined ? { malformedToolCall } : {}),
    })),
])
