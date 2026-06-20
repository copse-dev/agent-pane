import type { z } from 'zod'

export interface LLMTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

export interface ToolDefinition<TArgs = any> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  execute: (args: TArgs, signal: AbortSignal) => Promise<string>
  requiresApproval?: boolean
  /**
   * Pre-built JSON Schema for the tool's parameters. When set, the registry
   * forwards it to providers verbatim instead of deriving one from `parameters`.
   * Used by MCP tools whose schemas are JSON Schema, not Zod.
   */
  rawParameters?: Record<string, unknown>
}
