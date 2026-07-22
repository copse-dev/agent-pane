// Canonical definition lives in the LLM module, which owns the model-id
// namespacing vocabulary; re-exported here so remote-agent consumers keep their
// existing import path and the literal never drifts between the two.
export { REMOTE_AGENT_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { REMOTE_AGENT_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import {
  TRACKED_MODELS,
  cloudModelDisplayLabel,
  inferCloudModelProvider,
} from '@copse/llm/model-catalog.ts'
import { DEFAULT_MANAGED_AGENT_MODEL } from './managed-agents.ts'

export const REMOTE_AGENT_PROVIDER_CURSOR = 'cursor'
export const REMOTE_AGENT_PROVIDER_ANTHROPIC = 'anthropic'

export const REMOTE_AGENT_PROVIDERS = [
  REMOTE_AGENT_PROVIDER_CURSOR,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
] as const

export type RemoteAgentProvider = (typeof REMOTE_AGENT_PROVIDERS)[number]

export const DEFAULT_CURSOR_AGENT_BASE_URL = 'https://api.cursor.com'
export const DEFAULT_ANTHROPIC_AGENT_BASE_URL = 'https://api.anthropic.com'

/**
 * Optional model half of a remote-agent selection, encoded after `#` the same way
 * ACP does (`acp:<id>#<model>`). The model id may contain most characters but not
 * `#`, so a first-`#` split is unambiguous.
 */
const REMOTE_AGENT_MODEL_SEP = '#'

export interface RemoteAgentModelOption {
  provider: RemoteAgentProvider
  value: `${typeof REMOTE_AGENT_MODEL_PREFIX}${RemoteAgentProvider}`
  label: string
}

export const REMOTE_AGENT_MODELS: readonly RemoteAgentModelOption[] = [
  {
    provider: REMOTE_AGENT_PROVIDER_CURSOR,
    value: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_CURSOR}`,
    label: 'Cursor Cloud Agent',
  },
  {
    provider: REMOTE_AGENT_PROVIDER_ANTHROPIC,
    value: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_ANTHROPIC}`,
    label: 'Claude Cloud Agent',
  },
]

/**
 * Claude Managed Agents picker shortlist — the same Anthropic ids offered in the
 * "Cloud models" group, so they appear in the dropdown the same way. Bare
 * `remote-agent:anthropic` (no `#model`) still resolves to
 * {@link DEFAULT_MANAGED_AGENT_MODEL} for backwards compatibility.
 */
export const MANAGED_AGENT_PICKER_MODELS: readonly string[] = TRACKED_MODELS.filter(
  (id) => inferCloudModelProvider(id) === 'anthropic',
)

/** Ensure the create-agent default is always offered even if TRACKED_MODELS drifts. */
export const MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT: readonly string[] =
  ((): readonly string[] => {
    if (MANAGED_AGENT_PICKER_MODELS.includes(DEFAULT_MANAGED_AGENT_MODEL)) {
      return MANAGED_AGENT_PICKER_MODELS
    }
    return [DEFAULT_MANAGED_AGENT_MODEL, ...MANAGED_AGENT_PICKER_MODELS]
  })()

/** A `remote-agent:<provider>` / `remote-agent:<provider>#<model>` selection. */
export interface RemoteAgentModelSelection {
  provider: RemoteAgentProvider
  /** Upstream model id for Create Agent; omit to use the provider's account default. */
  model?: string
}

/** Build the model value the picker stores for a remote agent (+ optional model). */
export function remoteAgentModelValue(provider: RemoteAgentProvider, model?: string): string {
  return model
    ? `${REMOTE_AGENT_MODEL_PREFIX}${provider}${REMOTE_AGENT_MODEL_SEP}${model}`
    : `${REMOTE_AGENT_MODEL_PREFIX}${provider}`
}

/**
 * Decode a remote-agent picker value into `{ provider, model? }`, or `null` for
 * non-remote models / unknown providers / empty provider (`remote-agent:`).
 */
export function parseRemoteAgentModelSelection(model: string): RemoteAgentModelSelection | null {
  if (!model.startsWith(REMOTE_AGENT_MODEL_PREFIX)) return null
  const rest = model.slice(REMOTE_AGENT_MODEL_PREFIX.length)
  const sep = rest.indexOf(REMOTE_AGENT_MODEL_SEP)
  const provider = sep === -1 ? rest : rest.slice(0, sep)
  if (!REMOTE_AGENT_PROVIDERS.includes(provider as RemoteAgentProvider)) return null
  const chosen = sep === -1 ? '' : rest.slice(sep + 1)
  return chosen
    ? { provider: provider as RemoteAgentProvider, model: chosen }
    : { provider: provider as RemoteAgentProvider }
}

export function isRemoteAgentModel(model: string): boolean {
  return parseRemoteAgentModelSelection(model) !== null
}

/** Provider encoded in a remote-agent model value, or `null` for other models. */
export function parseRemoteAgentModel(model: string): RemoteAgentProvider | null {
  return parseRemoteAgentModelSelection(model)?.provider ?? null
}

/** Picker optgroup heading for a remote agent (mirrors ACP per-agent headings). */
export function remoteAgentGroupLabel(provider: RemoteAgentProvider): string {
  return REMOTE_AGENT_MODELS.find((option) => option.provider === provider)?.label ?? provider
}

/**
 * Human label for a remote-agent selection. When a specific model is chosen,
 * prefer a catalog display name (Cursor live list, or the shared Claude cloud
 * labels) and otherwise show the id.
 */
export function remoteAgentDisplayLabel(
  model: string,
  catalog: ReadonlyArray<{ id: string; label: string }> = [],
): string {
  const selection = parseRemoteAgentModelSelection(model)
  if (!selection) return model
  const title = remoteAgentGroupLabel(selection.provider)
  if (!selection.model) return title
  const catalogLabel = catalog.find((entry) => entry.id === selection.model)?.label
  return `${title} — ${catalogLabel ?? cloudModelDisplayLabel(selection.model)}`
}

/** Resolve the Anthropic Managed Agents model id for a selection (or the default). */
export function resolveManagedAgentModelId(selection: RemoteAgentModelSelection): string {
  return selection.model?.trim() || DEFAULT_MANAGED_AGENT_MODEL
}
