import type { StreamChunk } from '@shared/types'
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
}

export type ExploreSubagentRunner = (opts: {
  query: string
  paths?: string[]
  signal: AbortSignal
}) => Promise<{ summary: string; usage: { inputTokens: number; outputTokens: number } }>

let activeContext: ExploreSubagentRunnerContext | null = null
let accumulatedUsage = { inputTokens: 0, outputTokens: 0 }

export function resetSubagentUsage(): void {
  accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
}

export function getAccumulatedSubagentUsage(): { inputTokens: number; outputTokens: number } {
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
    })
    accumulatedUsage.inputTokens += result.usage.inputTokens
    accumulatedUsage.outputTokens += result.usage.outputTokens
    return result
  }
}
