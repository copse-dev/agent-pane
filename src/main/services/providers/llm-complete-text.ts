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
export async function completeMessagesWithUsage(
  provider: LLMProvider,
  messages: LLMMessage[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; usage: ModelUsage }> {
  let text = ''
  let usage = { ...EMPTY_USAGE }
  const controller = new AbortController()
  const abortFromCaller = (): void => {
    controller.abort(signal?.reason)
  }
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const deadline = { reached: false }
  const timer = setTimeout(() => {
    deadline.reached = true
    controller.abort()
  }, timeoutMs)
  try {
    for await (const chunk of provider.stream(messages, [], controller.signal)) {
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'usage') usage = mergeUsage(usage, usageFromChunk(chunk))
    }
    // Not every transport rejects on abort. The native LM Studio client answers
    // a cancel with a normal `userStopped` completion, so the stream above ends
    // cleanly with whatever text arrived before the budget ran out. A caller
    // that asked for a timeout must see it as one — a truncated answer that
    // looks like a fast, finished one is how a too-slow model passes for a
    // working one — so the deadline is surfaced here, the same way the HTTP
    // transports surface it on their own.
    if (deadline.reached) {
      throw new DOMException(
        `Completion did not finish within ${String(timeoutMs)}ms`,
        'TimeoutError',
      )
    }
    if (!usage.inputTokens && !usage.outputTokens && hasLastUsage(provider) && provider.lastUsage) {
      usage = { ...provider.lastUsage }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
  return { text, usage }
}

/** Convenience wrapper for the common single-user-prompt case. */
export function completeTextWithUsage(
  provider: LLMProvider,
  prompt: string,
  timeoutMs: number,
): Promise<{ text: string; usage: ModelUsage }> {
  return completeMessagesWithUsage(provider, [{ role: 'user', content: prompt }], timeoutMs)
}
