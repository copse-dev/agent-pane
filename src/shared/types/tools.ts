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

export interface LLMTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

export interface ToolDefinition<TArgs = any> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  execute: (args: TArgs, signal: AbortSignal) => Promise<ToolExecuteResult>
  requiresApproval?: boolean
  /**
   * Pre-built JSON Schema for the tool's parameters. When set, the registry
   * forwards it to providers verbatim instead of deriving one from `parameters`.
   * Used by MCP tools whose schemas are JSON Schema, not Zod.
   */
  rawParameters?: Record<string, unknown>
}
