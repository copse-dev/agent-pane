import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { memberOf } from '@shared/member-of.ts'
import { z } from 'zod'

const screeningReplySchema = z
  .object({
    confidence: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .catchall(z.unknown())

/**
 * Parse a safety model's raw reply — `{"<field>": one of `values`, "confidence",
 * "reason"}` — or return `null` when the output is unusable. This is the trust
 * boundary between the LLM's freeform text and the permission gates: it
 * extracts the first JSON object, rejects unknown values and reason-less
 * verdicts, and clamps confidence to `[0, 1]` so a malformed or adversarial
 * value can never widen an auto-run or auto-share gate.
 */
export function parseScreeningReply<const V extends readonly string[]>(
  text: string,
  field: string,
  values: V,
): { value: V[number]; confidence: number; reason: string } | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  const parsed = safeJsonParse(jsonMatch[0], decodeWithSchema(screeningReplySchema))
  if (!parsed) return null
  const value = parsed[field]
  if (!memberOf(values)(value)) return null
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  if (!reason) return null
  return { value, confidence, reason }
}

export interface ClassificationResult {
  scope: 'sandbox' | 'external'
  confidence: number
  reason: string
}

/**
 * Parse the shell-scope safety model's reply into a trusted
 * {@link ClassificationResult}; see {@link parseScreeningReply}.
 *
 * Kept free of any host/Electron imports so it stays unit-testable in isolation.
 */
export function parseClassification(text: string): ClassificationResult | null {
  const reply = parseScreeningReply(text, 'scope', ['sandbox', 'external'])
  return reply && { scope: reply.value, confidence: reply.confidence, reason: reply.reason }
}
