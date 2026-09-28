import { parseModelSelection } from './model-selection.ts'
import { memberOf } from '@copse/std/member-of.ts'

/** Model makers, independent of the service that carries a request. */
export const MODEL_MAKER_IDS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'mistral',
  'xai',
] as const
export type ModelMaker = (typeof MODEL_MAKER_IDS)[number]

export const MODEL_MAKERS: readonly { id: ModelMaker; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'xai', label: 'xAI' },
]

const isModelMaker = memberOf(MODEL_MAKER_IDS)
const MISTRAL_MODEL_FAMILIES = [
  'mistral',
  'mixtral',
  'codestral',
  'devstral',
  'magistral',
  'ministral',
  'pixtral',
] as const

/** Treat an absent or older setting as an empty block list. */
export function parseBlockedModelMakers(value: unknown): ModelMaker[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => isModelMaker(entry))
}

function makerFromName(name: string): ModelMaker | null {
  const normalized = name.toLowerCase()
  if (normalized === 'anthropic' || normalized.startsWith('claude-')) return 'anthropic'
  if (normalized === 'openai' || normalized.startsWith('gpt-') || /^o[1-9](?:-|$)/.test(normalized))
    return 'openai'
  if (
    normalized === 'google' ||
    normalized === 'gemini' ||
    normalized.startsWith('gemini-') ||
    normalized.startsWith('gemma-')
  )
    return 'google'
  if (normalized === 'deepseek' || normalized.startsWith('deepseek-')) return 'deepseek'
  if (
    normalized === 'mistralai' ||
    MISTRAL_MODEL_FAMILIES.some(
      (family) => normalized === family || normalized.startsWith(`${family}-`),
    )
  )
    return 'mistral'
  if (
    normalized === 'x-ai' ||
    normalized === 'xai' ||
    normalized === 'spacexai' ||
    normalized === 'grok' ||
    normalized.startsWith('grok-')
  )
    return 'xai'
  return null
}

function makerFromAgent(agent: string): ModelMaker | null {
  const normalized = agent.toLowerCase()
  if (normalized.startsWith('claude')) return 'anthropic'
  if (normalized.startsWith('codex')) return 'openai'
  if (normalized.startsWith('gemini')) return 'google'
  if (normalized.startsWith('mistral')) return 'mistral'
  if (normalized.startsWith('grok')) return 'xai'
  return null
}

/**
 * Identify the maker from a routed selection's upstream model id. An agent
 * without a pinned model is unknown unless its agent is maker-specific.
 * Plugin routes are opaque to Copse.
 */
export function modelMakerForSelection(value: string): ModelMaker | null {
  const selection = parseModelSelection(value)
  if (selection.namespace === 'auto' || selection.namespace === 'plugin-model') return null
  if (selection.namespace === 'remote-agent' && !selection.id) {
    return selection.agent === 'anthropic' ? 'anthropic' : null
  }
  if (selection.namespace === 'acp' && !selection.id) return makerFromAgent(selection.agent)

  const id = selection.id.toLowerCase()
  const parts = id.split('/')
  const first = parts[0] ?? ''
  const last = parts.at(-1) ?? ''
  const fromModel = makerFromName(first) ?? makerFromName(last)
  if (fromModel) return fromModel
  if (selection.namespace === 'acp') return makerFromAgent(selection.agent)
  return makerFromName(selection.slug)
}

export function blockedModelMaker(
  selection: string,
  blocked: readonly ModelMaker[],
): ModelMaker | null {
  const maker = modelMakerForSelection(selection)
  return maker && blocked.includes(maker) ? maker : null
}
