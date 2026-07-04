import type { LLMProvider, LLMMessage, ModelUsage } from '@shared/types'
import type { StreamChunk } from '@shared/types/stream.ts'

const EMPTY_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 }

interface ProviderWithUsage {
  lastUsage: ModelUsage | null
}

function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

function mergeUsage(prev: ModelUsage, delta: ModelUsage): ModelUsage {
  const next: ModelUsage = {
    inputTokens: prev.inputTokens + delta.inputTokens,
    outputTokens: prev.outputTokens + delta.outputTokens,
  }
  if (delta.cacheReadTokens !== undefined || prev.cacheReadTokens !== undefined) {
    next.cacheReadTokens = (prev.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0)
  }
  if (delta.cacheCreationTokens !== undefined || prev.cacheCreationTokens !== undefined) {
    next.cacheCreationTokens = (prev.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0)
  }
  return next
}

function usageFromChunk(chunk: Extract<StreamChunk, { type: 'usage' }>): ModelUsage {
  return {
    inputTokens: chunk.inputTokens,
    outputTokens: chunk.outputTokens,
    ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
    ...(chunk.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: chunk.cacheCreationTokens }
      : {}),
  }
}

/** Run a one-shot provider stream and return text plus accumulated token usage. */
export async function completeTextWithUsage(
  provider: LLMProvider,
  prompt: string,
  timeoutMs: number,
): Promise<{ text: string; usage: ModelUsage }> {
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  let text = ''
  let usage = { ...EMPTY_USAGE }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    for await (const chunk of provider.stream(messages, [], controller.signal)) {
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'usage') usage = mergeUsage(usage, usageFromChunk(chunk))
    }
    if (!usage.inputTokens && !usage.outputTokens && hasLastUsage(provider) && provider.lastUsage) {
      usage = { ...provider.lastUsage }
    }
  } finally {
    clearTimeout(timer)
  }
  return { text, usage }
}
