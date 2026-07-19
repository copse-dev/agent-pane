import { safeJsonParse } from '@shared/safe-json.ts'

/**
 * Pure verdict logic for the `read_terminal` scrollback screen (see
 * terminal-read-guard.ts). Kept free of any host/Electron imports so it stays
 * unit-testable in isolation, mirroring safety-classification-parse.ts.
 */

export interface TerminalReadVerdict {
  risky: boolean
  confidence: number
  reason: string
}

/**
 * Parse the safety model's raw reply into a trusted verdict, or `null` when
 * unusable. This is the trust boundary between LLM freeform text and the
 * permission gate: unknown risk values and reason-less verdicts are rejected
 * and confidence is clamped so a malformed or adversarial value can never
 * widen the auto-allow gate.
 */
export function parseTerminalReadVerdict(text: string): TerminalReadVerdict | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  const parsed = safeJsonParse<{ risk?: string; confidence?: number; reason?: string }>(
    jsonMatch[0],
  )
  if (!parsed) return null
  if (parsed.risk !== 'safe' && parsed.risk !== 'risky') return null
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  if (!reason) return null
  return { risky: parsed.risk === 'risky', confidence, reason }
}

/**
 * Whether a screening outcome must be escalated to the user. Fail-closed into
 * the approval prompt (never into a silent allow): no verdict means the
 * classifier is off, unreachable, or produced garbage — the user decides. A
 * "safe" verdict auto-allows only when the model is reasonably confident.
 */
export function terminalReadNeedsApproval(verdict: TerminalReadVerdict | null): boolean {
  if (!verdict) return true
  return verdict.risky || verdict.confidence < 0.5
}
