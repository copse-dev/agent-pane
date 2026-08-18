import type { Message } from '@shared/types'
import {
  SAMPLING_FIELDS,
  type ModelParameters,
  type SamplingField,
} from '@copse/llm/model-parameters.ts'
import { displayModelLabel } from '@shared/model-display.ts'

/**
 * Distinct primary-chat models stamped on assistant messages in this thread.
 * Subagent models are ignored — they already render on their own cards.
 */
export function primaryChatModels(messages: readonly Message[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.model || seen.has(msg.model)) continue
    seen.add(msg.model)
    out.push(msg.model)
  }
  return out
}

/**
 * A message's model and resolved parameters as one comparable string, so a
 * label can mark where *either* changed. Turns that sent no parameters collapse
 * to the model alone, which keeps an untuned thread on the old behaviour.
 */
function primaryChatSignature(msg: Message): string {
  const params = msg.parameters ?? {}
  return [
    msg.model ?? '',
    params.reasoning ?? '',
    ...SAMPLING_FIELDS.map((field) => params[field] ?? ''),
  ].join('|')
}

/**
 * True when the transcript should show per-message model labels: when the
 * primary chat has used more than one model, or run the same model with more
 * than one set of parameters. The footer picker already shows the active route
 * and the current dial, so a thread that never changed either stays unlabeled.
 */
export function shouldShowPrimaryChatModelLabels(messages: readonly Message[]): boolean {
  if (primaryChatModels(messages).length > 1) return true
  const signatures = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.model) continue
    signatures.add(primaryChatSignature(msg))
  }
  return signatures.size > 1
}

/**
 * The parameters a turn ran with, in the compact form the label appends —
 * `max effort · temp 1 · top-p 0.95`. Empty when the turn sent none.
 */
/** Abbreviations for the transcript label, where the line has to stay short. */
const SAMPLING_LABELS: Readonly<Record<SamplingField, string>> = {
  temperature: 'temp',
  topP: 'top-p',
  topK: 'top-k',
  minP: 'min-p',
  presencePenalty: 'presence',
  repetitionPenalty: 'repetition',
}

export function formatTurnParameters(parameters: ModelParameters | undefined): string {
  if (!parameters) return ''
  const parts: string[] = []
  if (parameters.reasoning !== undefined) {
    parts.push(parameters.reasoning === 'off' ? 'no thinking' : `${parameters.reasoning} effort`)
  }
  for (const field of SAMPLING_FIELDS) {
    const value = parameters[field]
    if (value !== undefined) parts.push(`${SAMPLING_LABELS[field]} ${String(value)}`)
  }
  return parts.join(' · ')
}

/**
 * Display label for a primary-chat model id (matches subagent badge local form),
 * with the turn's resolved parameters appended when it ran with any.
 */
export function formatPrimaryChatModelLabel(model: string, parameters?: ModelParameters): string {
  const tuning = formatTurnParameters(parameters)
  return tuning ? `${modelLabel(model)} · ${tuning}` : modelLabel(model)
}

function modelLabel(model: string): string {
  return displayModelLabel(model)
}
