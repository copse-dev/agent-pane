import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

// Only unwrap the simple MCP failure envelope. Other JSON results may carry
// structured details that a prose-only view would hide.
const mcpErrorEnvelopeSchema = z
  .object({
    result: z.null(),
    error: z.object({ message: z.string().min(1) }).strict(),
  })
  .strict()

export function mcpErrorMessage(result: string): string | null {
  if (!result.trimStart().startsWith('{')) return null
  return safeJsonParse(result, decodeWithSchema(mcpErrorEnvelopeSchema))?.error.message ?? null
}
