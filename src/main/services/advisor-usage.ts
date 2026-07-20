import type { ModelUsage, StreamChunk } from '@shared/types'

/**
 * Emit advisor tokens on the advisor model as a dedicated usage line (#566).
 * Pure — kept out of advisor-runner so unit tests do not load electron-store.
 */
export function emitAdvisorUsage(
  onChunk: (chunk: StreamChunk) => void,
  advisorModel: string,
  usage: ModelUsage,
): void {
  if (!usage.inputTokens && !usage.outputTokens) return
  onChunk({
    type: 'usage',
    model: advisorModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usageSource: 'advisor',
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
  })
}
