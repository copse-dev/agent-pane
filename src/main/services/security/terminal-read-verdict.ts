import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { z } from 'zod'

const terminalReadPayloadSchema = z.object({
  risk: z.string().optional(),
  confidence: z.unknown().optional(),
  reason: z.string().optional(),
})

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
 * How much of a snapshot the safety model is shown: its trailing slice — the
 * most recent output, which is also what the agent asked for. Safety models may
 * have small context windows and the screening call has a short timeout, so
 * the window is deliberately modest.
 *
 * The window is also the limit of what a verdict can vouch for. A snapshot
 * larger than this is never auto-shared on a "safe" verdict: the model saw
 * only the tail, and a confident "ordinary build log" for the tail says
 * nothing about a token or an instruction to the agent scrolled above it
 * (#2280). What the model did not see goes to the user instead.
 */
export const TERMINAL_READ_SCREEN_MAX_CHARS = 6_000

export interface TerminalReadScreenWindow {
  /** The trailing slice the safety model is shown. */
  screened: string
  /** Characters above the window that the model never sees; 0 when it all fits. */
  unscreenedChars: number
  /**
   * Lines whose content lies entirely above the window. A line cut by the
   * boundary is partly visible to the model and is not counted; one whose only
   * screened character is its terminating newline showed the model nothing, so
   * it is. `unscreenedChars` is the gate's criterion, this is for the
   * user-facing explanation.
   */
  unscreenedLines: number
  /** Lines in the whole snapshot. */
  totalLines: number
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1
  return count
}

/** Split a snapshot into the part the safety model screens and the part it never sees. */
export function terminalReadScreenWindow(text: string): TerminalReadScreenWindow {
  const totalLines = text.length === 0 ? 0 : countNewlines(text) + 1
  const unscreenedChars = Math.max(0, text.length - TERMINAL_READ_SCREEN_MAX_CHARS)
  if (unscreenedChars === 0) {
    return { screened: text, unscreenedChars: 0, unscreenedLines: 0, totalLines }
  }
  return {
    screened: text.slice(-TERMINAL_READ_SCREEN_MAX_CHARS),
    unscreenedChars,
    unscreenedLines: countNewlines(text.slice(0, unscreenedChars + 1)),
    totalLines,
  }
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
  const parsed = safeJsonParse(jsonMatch[0], decodeWithSchema(terminalReadPayloadSchema))
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
