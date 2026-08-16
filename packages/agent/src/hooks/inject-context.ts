import type { LLMMessage } from '@copse/llm/wire-types.ts'
import type { OperatorInstructionPlacement } from '@copse/llm/model-catalog.ts'

// Current-turn context injection (H2 of the hooks platform).
//
// A *blocking* hook may return `injectContext` (the canonical vocabulary field —
// docs/plans/hooks-and-feature-packs.md, decision 11). Blocking hooks inject at
// their fire point *into the current turn*; async hooks cannot (the type blocks
// it, and async output routes through the pending-message queue instead).
//
// This module is the pure, Electron-free formatting + capping half of H2:
//   - `injectContext` is placed into the turn as a **system-reminder block** so
//     the model reads it as an out-of-band instruction, not as user/tool prose.
//   - It is capped at {@link INJECT_CONTEXT_CHAR_CAP} (10k) so a runaway hook
//     cannot blow the turn's context budget. On overflow the block is truncated
//     and a note surfaces that the full text is preserved in the thread spine —
//     command hooks always blob their full raw stdout (decision 6 / A3), which
//     is where the un-truncated `additionalContext` lives, so nothing is lost.
//
// The fire-site wiring (append to a tool result for `toolGate`, compose the turn
// for `beforeSubmitPrompt`) is host-side; this module turns a raw injected
// string into the exact block that enters the turn — and, for the turn-composition
// path, owns *where* that block lands, because the position is a caching
// invariant rather than a formatting detail (see `appendOperatorInstruction`).

/**
 * Character cap for context a blocking hook injects into the current turn (H2).
 * Vendor parity: Claude's hook output guidance caps injected context at ~10k and
 * spills the remainder; we mirror that ceiling (decision 11 + the vendor audit's
 * ">10k output spillover" row) so imported hooks behave identically.
 */
export const INJECT_CONTEXT_CHAR_CAP = 10_000

/** The tag name wrapping injected context — an out-of-band instruction block. */
export const SYSTEM_REMINDER_TAG = 'system-reminder'

/** The result of capping a raw injected string at the char cap. */
export interface CappedInjectContext {
  /** The (possibly truncated) body that enters the turn — never longer than `cap`. */
  text: string
  /** True when the raw text exceeded the cap and was truncated. */
  truncated: boolean
  /** Full character length of the raw injected context (pre-cap) — the spine records this. */
  fullLength: number
  /** The remainder beyond the cap (empty when not truncated); the full text lives in the spine blob. */
  overflow: string
}

/**
 * Cap a raw injected string at `cap` characters. Pure and total: a string at or
 * under the cap passes through untouched (`truncated: false`), an over-cap
 * string is split into the kept `text` and the `overflow` remainder.
 */
export function capInjectContext(raw: string, cap = INJECT_CONTEXT_CHAR_CAP): CappedInjectContext {
  const fullLength = raw.length
  if (fullLength <= cap) return { text: raw, truncated: false, fullLength, overflow: '' }
  return { text: raw.slice(0, cap), truncated: true, fullLength, overflow: raw.slice(cap) }
}

/** Wrap text in the system-reminder block that enters the current turn. */
export function formatSystemReminder(text: string): string {
  return `<${SYSTEM_REMINDER_TAG}>\n${text}\n</${SYSTEM_REMINDER_TAG}>`
}

/**
 * Build the current-turn system-reminder block for a hook's injected context
 * (H2). Returns `undefined` for empty / whitespace-only input so callers can
 * skip injection cleanly. On overflow the block is capped at
 * {@link INJECT_CONTEXT_CHAR_CAP} and ends with a note that the full text is
 * preserved in the thread spine (the command hook's stdout blob — A3), so the
 * transcript stays honest about the truncation while the model's context budget
 * is bounded.
 */
export function buildInjectedContextBlock(
  raw: string | undefined,
  cap = INJECT_CONTEXT_CHAR_CAP,
): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const capped = capInjectContext(raw, cap)
  const body = capped.truncated
    ? `${capped.text}\n\n[context truncated: showing the first ${String(cap)} of ` +
      `${String(capped.fullLength)} characters; the full text is preserved in the thread spine]`
    : capped.text
  return formatSystemReminder(body)
}

/**
 * Place this turn's operator instructions — `turnStart` steering (M0.2) and any
 * `beforeSubmitPrompt` injected context (H2) — in the strongest channel the
 * selected model is known to accept. Returns whether anything was placed.
 *
 * GPT models use a trailing `developer` message. Models on the explicit late-
 * system allowlist use a trailing `system` message. Every other selection — in
 * particular LM Studio / MLX models whose templates may reject extra roles or
 * multiple system turns — folds the text into the first system prompt. That
 * fallback sacrifices prefix-cache stability when steering changes, but keeps
 * the request valid and retains system authority without pseudo-role markup.
 *
 * Empty and whitespace-only blocks are dropped, so a hook that fires but injects
 * nothing leaves `messages` untouched — and therefore leaves the prefix intact.
 */
export function appendOperatorInstruction(
  messages: LLMMessage[],
  blocks: ReadonlyArray<string | undefined>,
  placement: OperatorInstructionPlacement,
): boolean {
  const present = blocks.filter(
    (block): block is string => block !== undefined && block.trim().length > 0,
  )
  if (present.length === 0) return false
  const content = present.join('\n\n')
  if (placement === 'trailing-developer') {
    messages.push({ role: 'developer', content })
    return true
  }
  if (placement === 'trailing-system') {
    messages.push({ role: 'system', content })
    return true
  }

  const systemIndex = messages.findIndex((message) => message.role === 'system')
  if (systemIndex < 0) {
    messages.unshift({ role: 'system', content })
    return true
  }
  const system = messages[systemIndex]
  if (system?.role !== 'system') return false
  messages[systemIndex] = {
    role: 'system',
    content: system.content.length > 0 ? `${system.content}\n\n${content}` : content,
  }
  return true
}
