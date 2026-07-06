import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelUsage, StreamChunk } from '@shared/types'
import { runExploreSubagent } from './subagent-service.ts'
import type { LLMProvider } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { addSubagentUsage } from './subagent-usage.ts'

export interface ExploreSubagentRunnerContext {
  parentToolCallId: string
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  onChunk: (chunk: StreamChunk) => void
  usageModel: string
  /** Local subagent routing was requested but unavailable; run uses the cloud model. */
  localFallback?: boolean
}

export type ExploreSubagentRunner = (opts: {
  query: string
  paths?: string[] | undefined
  signal: AbortSignal
}) => Promise<{ summary: string; usage: ModelUsage }>

/**
 * Context travels via AsyncLocalStorage, not a module-global slot: the parent
 * loop runs several `explore` tool calls concurrently (see
 * `startLeadingParallelExplores`), and a single slot would hand one call's
 * parentToolCallId/provider to a sibling. Each `runWithExploreSubagentContext`
 * scope sees only its own context.
 */
const contextStorage = new AsyncLocalStorage<ExploreSubagentRunnerContext>()

export function runWithExploreSubagentContext<T>(
  ctx: ExploreSubagentRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

export function getExploreSubagentRunner(): ExploreSubagentRunner | null {
  const ctx = contextStorage.getStore()
  if (!ctx) return null
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
      ...(ctx.localFallback !== undefined ? { localFallback: ctx.localFallback } : {}),
    })
    addSubagentUsage(result.usage)
    return result
  }
}
