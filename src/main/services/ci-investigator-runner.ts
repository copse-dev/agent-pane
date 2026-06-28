import type { ModelUsage, StreamChunk } from '@shared/types'
import { runCiInvestigatorSubagent } from './ci-investigator-service.ts'
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
}

export type CiInvestigatorRunner = (opts: {
  focus?: string
  prNumber?: number
  signal: AbortSignal
}) => Promise<{ summary: string; usage: ModelUsage }>

let activeContext: CiInvestigatorRunnerContext | null = null

export function setCiInvestigatorContext(ctx: CiInvestigatorRunnerContext | null): void {
  activeContext = ctx
}

export function getCiInvestigatorRunner(): CiInvestigatorRunner | null {
  if (!activeContext) return null
  const ctx = activeContext
  return async ({ focus, prNumber, signal }) => {
    const result = await runCiInvestigatorSubagent({
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
    })
    addSubagentUsage(result.usage)
    return result
  }
}
