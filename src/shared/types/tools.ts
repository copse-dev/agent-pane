import type { z } from 'zod'

/** Per-file line add/delete counts for write_file / str_replace tool cards. */
export interface ToolEditStats {
  additions: number
  deletions: number
}

export type ToolExecuteResult = string | { result: string; editStats?: ToolEditStats }

export function normalizeToolExecuteResult(value: ToolExecuteResult): {
  result: string
  editStats?: ToolEditStats
} {
  if (typeof value === 'string') return { result: value }
  return value
}

// Owned by the LLM module (crosses the provider contract); re-exported here so
// `@shared/types` consumers are unchanged.
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
