import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelUsage, StreamChunk } from '@shared/types'
import { runCiInvestigatorSubagent } from './github/ci-investigator-service.ts'
import type { LLMProvider } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { addSubagentUsage } from './subagent-usage.ts'

export interface CiInvestigatorRunnerContext {
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

export type CiInvestigatorRunner = (opts: {
  focus?: string | undefined
  prNumber?: number | undefined
  signal: AbortSignal
}) => Promise<{ summary: string; usage: ModelUsage }>

/**
 * Context travels via AsyncLocalStorage, not a module-global slot: the tool
 * reads it only after awaiting inside the registry (permission checks), so a
 * second thread's concurrent `investigate_ci` call could replace a global slot
 * in the meantime — the first thread's subagent then ran with the second's
 * provider/registry and streamed into its conversation, and the second saw
 * the slot cleared. Each `runWithCiInvestigatorContext` scope sees only its own
 * context.
 */
const contextStorage = new AsyncLocalStorage<CiInvestigatorRunnerContext>()

export function runWithCiInvestigatorContext<T>(
  ctx: CiInvestigatorRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

export function getCiInvestigatorRunner(
  investigate: typeof runCiInvestigatorSubagent = runCiInvestigatorSubagent,
): CiInvestigatorRunner | null {
  const ctx = contextStorage.getStore()
  if (!ctx) return null
  return async ({ focus, prNumber, signal }) => {
    const result = await investigate({
      parentToolCallId: ctx.parentToolCallId,
      ...(focus !== undefined ? { focus } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
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
