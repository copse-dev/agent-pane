import { z } from 'zod'
import { decodeWithSchema, safeJsonParse, safeJsonStringify } from '../safe-json.ts'
import type { HookRunDetail } from '../types/hooks.ts'

/**
 * Presentation model for the hook-card inspector: turns the raw
 * {@link HookRunDetail} the main process reads off the spine into the labeled
 * blocks the card renders.
 *
 * The split exists because the interesting part is not the transport, it is the
 * *labelling*: a command hook's exchange is stdin → stdout → stderr, while a
 * function hook's is a dispatch payload and a set of applied text channels that
 * are stored as one JSON blob and have to be broken back apart (an injected
 * steering block is unreadable as a JSON-escaped one-liner). Both collapse to
 * the same list of sections here, so the DOM side stays dumb and this stays
 * unit-testable.
 */

/** One labeled block in the inspector — a stream, a payload, or an applied channel. */
export interface HookRunSection {
  label: string
  text: string
  /** `json` gets monospace + a pretty-print pass; `text` renders verbatim. */
  format: 'json' | 'text'
}

/**
 * The outcome blob a function-hook run captures. Written by the recorder, but
 * read back off disk, so it is decoded rather than trusted — a hand-edited or
 * half-written blob degrades to "show the raw text", never a throw.
 */
const outcomeCaptureSchema = z.object({
  decision: z.string().optional(),
  haltReason: z.string().optional(),
  updatedInput: z.unknown().optional(),
  injectContext: z.string().optional(),
  agentMessage: z.string().optional(),
  userMessage: z.string().optional(),
})

/** Compact facts about the execution, shown as chips above the streams. */
export function hookRunDetailChips(detail: HookRunDetail): string[] {
  if (!detail.found) return []
  const chips: string[] = []
  if (detail.event !== undefined) chips.push(detail.event)
  if (detail.executor !== undefined) chips.push(detail.executor)
  if (detail.exitCode !== undefined) {
    chips.push(detail.exitCode === null ? 'killed' : `exit ${String(detail.exitCode)}`)
  }
  if (detail.durationMs !== undefined) chips.push(`${String(detail.durationMs)} ms`)
  if (detail.parseOk === false) chips.push('parse failed')
  // The emitting step is what correlates a hook run with the LLM call it ran
  // around — the single most useful field when a hook fired "at the wrong time".
  if (detail.step !== undefined) chips.push(`step ${String(detail.step)}`)
  return chips
}

/** Pretty-print an already-decoded value; null when there is nothing to show. */
function stringifyJson(value: unknown): string | null {
  try {
    return safeJsonStringify(value, 2) ?? null
  } catch {
    return null
  }
}

/** Pretty-print JSON text; return it untouched when it does not parse. */
function prettyJson(text: string): string {
  const value = safeJsonParse(text)
  if (value === null) return text
  try {
    return safeJsonStringify(value, 2) ?? text
  } catch {
    return text
  }
}

/**
 * Break a function hook's captured outcome into one section per channel it
 * applied, so injected context reads as the text the model actually received.
 * An undecodable blob falls back to a single raw section rather than vanishing.
 */
function outcomeSections(outcome: string): HookRunSection[] {
  const parsed = safeJsonParse(outcome, decodeWithSchema(outcomeCaptureSchema))
  if (parsed === null) return [{ label: 'outcome', text: outcome, format: 'json' }]
  const sections: HookRunSection[] = []
  if (parsed.injectContext !== undefined) {
    sections.push({ label: 'injected context', text: parsed.injectContext, format: 'text' })
  }
  if (parsed.agentMessage !== undefined) {
    sections.push({ label: 'message to agent', text: parsed.agentMessage, format: 'text' })
  }
  if (parsed.userMessage !== undefined) {
    sections.push({ label: 'message to you', text: parsed.userMessage, format: 'text' })
  }
  if (parsed.haltReason !== undefined) {
    sections.push({ label: 'halt reason', text: parsed.haltReason, format: 'text' })
  }
  const updatedInput = stringifyJson(parsed.updatedInput)
  if (updatedInput !== null) {
    sections.push({ label: 'rewritten tool input', text: updatedInput, format: 'json' })
  }
  // A decision with no text channel would otherwise render an empty inspector:
  // fall back to the raw capture so the disclosure always shows something real.
  if (sections.length === 0) return [{ label: 'outcome', text: outcome, format: 'json' }]
  return sections
}

/**
 * Every block the inspector shows, in the order a reader wants them: what the
 * hook was handed first, then what it did with it. Command hooks label their
 * payload `stdin` because that is literally what the process read.
 */
export function hookRunDetailSections(detail: HookRunDetail): HookRunSection[] {
  if (!detail.found) return []
  const sections: HookRunSection[] = []
  if (detail.payload !== undefined) {
    sections.push({
      label: detail.executor === 'command' ? 'stdin' : 'payload',
      text: prettyJson(detail.payload),
      format: 'json',
    })
  }
  if (detail.outcome !== undefined) sections.push(...outcomeSections(detail.outcome))
  if (detail.stdout !== undefined) {
    sections.push({ label: 'stdout', text: detail.stdout, format: 'text' })
  }
  // stderr is only worth a block when the hook actually said something on it —
  // an empty stderr is the normal case and adds nothing but scroll.
  if (detail.stderr !== undefined && detail.stderr.trim().length > 0) {
    sections.push({ label: 'stderr', text: detail.stderr, format: 'text' })
  }
  return sections
}

/**
 * One-line explanation when there is nothing to show, so an opened inspector is
 * never a blank box: either the run is not on the spine, its blobs are gone, or
 * the hook genuinely produced nothing worth capturing.
 */
export function hookRunDetailEmptyReason(detail: HookRunDetail): string | null {
  if (!detail.found) {
    return 'This run is not recorded in the thread yet — reopen the thread to inspect it.'
  }
  if (hookRunDetailSections(detail).length > 0) return null
  if (detail.missing !== undefined && detail.missing.length > 0) {
    return 'The captured output for this run is no longer stored.'
  }
  // Deliberately not "the hook abstained": a run recorded before capture existed
  // looks identical from here, and guessing between them would be a lie either
  // way. Name both, and let the reader pick.
  return 'Nothing was captured for this run (an abstaining hook, or a run recorded before capture existed).'
}
