import type { z } from 'zod'

// The tool-execution result contract is owned by the agent module (it is what
// a tool hands back to the loop); `LLMTool` is owned by the LLM module (it
// crosses the provider contract). Re-exported here so `@shared/types`
// consumers are unchanged.
import type { ToolExecuteResult } from '@copse/agent/wire-types.ts'
export type { ToolEditStats, ToolExecuteResult } from '@copse/agent/wire-types.ts'
export { normalizeToolExecuteResult } from '@copse/agent/wire-types.ts'
export type { LLMTool } from '@copse/llm/wire-types.ts'

export interface ToolDefinition<TArgs = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  /**
   * Run the tool. May be sync or async — the registry always awaits the result,
   * so a purely synchronous tool need not be marked `async`.
   */
  execute: (args: TArgs, signal: AbortSignal) => ToolExecuteResult | Promise<ToolExecuteResult>
  requiresApproval?: boolean
  /**
   * Pre-built JSON Schema for the tool's parameters. When set, the registry
   * forwards it to providers verbatim instead of deriving one from `parameters`.
   * Used by MCP tools whose schemas are JSON Schema, not Zod.
   */
  rawParameters?: Record<string, unknown>
}

/**
 * Defines a tool while inferring its argument type from the Zod `parameters`
 * schema, so `execute` receives fully-typed args. Prefer this over annotating
 * `: ToolDefinition`, which erases the arg type to `unknown` and forces unsafe
 * member access inside `execute`.
 */
export function defineTool<TArgs>(def: ToolDefinition<TArgs>): ToolDefinition<TArgs> {
  return def
}
