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
}
