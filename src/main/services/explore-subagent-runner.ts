import type { ModelUsage, StreamChunk } from '@shared/types'
import { runExploreSubagent } from './subagent-service.ts'
import type { LLMProvider } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'

export interface ExploreSubagentRunnerContext {
  parentToolCallId: string
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  onChunk: (chunk: StreamChunk) => void
  usageModel: string
}

export type ExploreSubagentRunner = (opts: {
  query: string
  paths?: string[]
  signal: AbortSignal
}) => Promise<{ summary: string; usage: ModelUsage }>

let activeContext: ExploreSubagentRunnerContext | null = null
let accumulatedUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 }

export function resetSubagentUsage(): void {
  accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
}

export function getAccumulatedSubagentUsage(): ModelUsage {
  return accumulatedUsage
}

export function setExploreSubagentContext(ctx: ExploreSubagentRunnerContext | null): void {
  activeContext = ctx
}

export function getExploreSubagentRunner(): ExploreSubagentRunner | null {
  if (!activeContext) return null
  const ctx = activeContext
  return async ({ query, paths, signal }) => {
    const result = await runExploreSubagent({
      parentToolCallId: ctx.parentToolCallId,
      query,
      ...(paths !== undefined ? { paths } : {}),
      parentGoal: ctx.parentGoal,
      provider: ctx.provider,
      registry: ctx.registry,
      contextWindow: ctx.contextWindow,
      toolSchemaReserve: ctx.toolSchemaReserve,
      signal,
      onChunk: ctx.onChunk,
      usageModel: ctx.usageModel,
    })
    accumulatedUsage.inputTokens += result.usage.inputTokens
    accumulatedUsage.outputTokens += result.usage.outputTokens
    if (result.usage.cacheReadTokens !== undefined) {
      accumulatedUsage.cacheReadTokens =
        (accumulatedUsage.cacheReadTokens ?? 0) + result.usage.cacheReadTokens
    }
    if (result.usage.cacheCreationTokens !== undefined) {
      accumulatedUsage.cacheCreationTokens =
        (accumulatedUsage.cacheCreationTokens ?? 0) + result.usage.cacheCreationTokens
    }
    return result
  }
}
