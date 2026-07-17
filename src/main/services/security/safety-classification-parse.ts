import { safeJsonParse } from '@shared/safe-json.ts'

export interface ClassificationResult {
  scope: 'sandbox' | 'external'
  confidence: number
  reason: string
}

/**
 * Parse the safety model's raw reply into a trusted {@link ClassificationResult},
 * or `null` when the output is unusable. This is the trust boundary between the
 * LLM's freeform text and the permission gate: it extracts the first JSON object,
 * rejects unknown scopes and reason-less verdicts, and clamps confidence to
 * `[0, 1]` so a malformed or adversarial value can never widen the auto-run gate.
 *
 * Kept free of any host/Electron imports so it stays unit-testable in isolation.
 */
export function parseClassification(text: string): ClassificationResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  const parsed = safeJsonParse<{
    scope?: string
    confidence?: number
    reason?: string
  }>(jsonMatch[0])
  if (!parsed) return null
  if (parsed.scope !== 'sandbox' && parsed.scope !== 'external') return null
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  if (!reason) return null
  return { scope: parsed.scope, confidence, reason }
}
