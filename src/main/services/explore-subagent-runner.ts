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

let activeContext: ExploreSubagentRunnerContext | null = null

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
      ...(ctx.localFallback !== undefined ? { localFallback: ctx.localFallback } : {}),
    })
    addSubagentUsage(result.usage)
    return result
  }
}
