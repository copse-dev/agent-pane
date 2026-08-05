import type { Message } from '@shared/types'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import { cloudModelDisplayLabel } from '@copse/llm/model-catalog.ts'
import { isOpenRouterModel, openRouterDisplayLabel } from '@copse/llm/openrouter.ts'
import { isExtraProviderModel, extraProviderDisplayLabel } from '@copse/llm/extra-providers.ts'
import { BEST_VALUE_CHAT_MODEL_LABEL, isBestValueChatModel } from '@shared/lm-studio-defaults.ts'

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
  const { reasoning, temperature, topP } = msg.parameters ?? {}
  return [msg.model ?? '', reasoning ?? '', temperature ?? '', topP ?? ''].join('|')
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
export function formatTurnParameters(parameters: ModelParameters | undefined): string {
  if (!parameters) return ''
  const parts: string[] = []
  if (parameters.reasoning !== undefined) {
    parts.push(parameters.reasoning === 'off' ? 'no thinking' : `${parameters.reasoning} effort`)
  }
  if (parameters.temperature !== undefined) parts.push(`temp ${String(parameters.temperature)}`)
  if (parameters.topP !== undefined) parts.push(`top-p ${String(parameters.topP)}`)
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
  if (isBestValueChatModel(model)) return BEST_VALUE_CHAT_MODEL_LABEL
  if (model.startsWith('lmstudio:')) return `${model.slice('lmstudio:'.length)} · local`
  if (isOpenRouterModel(model)) return openRouterDisplayLabel(model)
  if (isExtraProviderModel(model)) return extraProviderDisplayLabel(model)
  return cloudModelDisplayLabel(model)
}
