import type { ApiClient } from '../../preload/api.d.ts'
import { CLOUD_MODELS } from '@shared/llm/model-catalog.ts'
import {
  isOpenRouterModel,
  openRouterDisplayLabel,
  openRouterModelId,
  toOpenRouterModel,
} from '@shared/llm/openrouter.ts'
import {
  extraProviderDisplayLabel,
  extraProviderModelId,
  extraProviderSlugFromModel,
  isExtraProviderModel,
  toExtraProviderModel,
  type ExtraProvider,
} from '@shared/llm/extra-providers.ts'

type AvailableProviders = Awaited<ReturnType<ApiClient['settings']['availableProviders']>>
import {
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_MODEL_PREFIX,
  REMOTE_AGENT_PROVIDER_CURSOR,
  parseRemoteAgentModel,
} from '@shared/remote-agent.ts'
import { clear } from '../dom/helpers.ts'

const OPENROUTER_GROUP = 'OpenRouter'

export interface ModelOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

export function modelDisplayLabel(model: string): string {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  if (isOpenRouterModel(model)) return openRouterDisplayLabel(model)
  if (isExtraProviderModel(model)) return extraProviderDisplayLabel(model)
  const remoteProvider = parseRemoteAgentModel(model)
  if (remoteProvider) {
    // RemoteAgentProvider is a single-member union today, so the match is always
    // true per types; the comparison stays so new providers select their own label.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return REMOTE_AGENT_MODELS.find((option) => option.provider === remoteProvider)?.label ?? model
  }
  return model
}

// OpenRouter's free, tool-capable models fetched live from its catalog, plus any
// custom id the user saved (or currently has selected — which may be a paid id).
// When no key is configured we contribute nothing (the provider is hidden from
// the picker rather than shown as a disabled "add a key" row).
async function openRouterOptions(
  api: ApiClient,
  available: boolean,
  current: string,
): Promise<ModelOption[]> {
  if (!available) return []

  let liveModels: Array<{ id: string; name: string }> = []
  try {
    liveModels = await api.openRouter.models()
  } catch {
    /* network error — fall through to custom/current only */
  }

  let customId = ''
  try {
    customId = (((await api.settings.get('openRouterModel')) as string | null) ?? '').trim()
  } catch {
    /* no custom model configured */
  }

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string): void => {
    const value = toOpenRouterModel(id)
    if (!id || seen.has(value)) return
    seen.add(value)
    entries.push({ value, label, group: OPENROUTER_GROUP })
  }

  for (const model of liveModels) add(model.id, model.name || model.id)
  if (customId) add(customId, `${customId} (custom)`)
  if (isOpenRouterModel(current)) add(openRouterModelId(current), modelDisplayLabel(current))

  if (entries.length === 0) {
    return [
      {
        value: '',
        label: 'No free tool-capable models found',
        group: OPENROUTER_GROUP,
        disabled: true,
      },
    ]
  }
  return entries
}

// Curated, tool-capable models for a direct cloud provider (Mistral, Gemini,
// DeepSeek, or a user-added one). Unlike OpenRouter there is no live catalog, so
// the shortlist comes from the registry; the currently-selected id is kept
// selectable even if it isn't in the shortlist. An unconfigured provider (no key)
// contributes nothing — it's hidden from the picker rather than shown as a hint.
function extraProviderOptions(
  provider: ExtraProvider,
  available: boolean,
  current: string,
): ModelOption[] {
  if (!available) return []

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string): void => {
    const value = toExtraProviderModel(provider.id, id)
    if (!id || seen.has(value)) return
    seen.add(value)
    entries.push({ value, label, group: provider.label })
  }

  for (const model of provider.models) add(model.id, model.label ?? model.id)
  if (extraProviderSlugFromModel(current) === provider.id) {
    add(extraProviderModelId(current), modelDisplayLabel(current))
  }
  return entries
}

export async function fetchModelOptions(api: ApiClient, current: string): Promise<ModelOption[]> {
  const options: ModelOption[] = []

  let available: AvailableProviders = {}
  try {
    available = await api.settings.availableProviders()
  } catch {
    /* keep defaults */
  }
  // When availability is unknown (e.g. the query failed), default to showing the
  // option rather than hiding it behind an "add a key" hint.
  const isAvailable = (provider: string): boolean => available[provider] ?? true
  // Hosted Anthropic/OpenAI models. Grouped so they get a heading like every
  // other section (otherwise they'd be the only headingless block at the top).
  const cloudGroup = 'Cloud models'
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (isAvailable(provider)) options.push({ value, label, group: cloudGroup })
  }

  options.push(...(await openRouterOptions(api, isAvailable('openrouter'), current)))

  let extraProviders: ExtraProvider[] = []
  try {
    extraProviders = await api.settings.extraProviders()
  } catch {
    /* no extra providers available */
  }
  for (const provider of extraProviders) {
    options.push(...extraProviderOptions(provider, isAvailable(provider.id), current))
  }

  // Remote agents (Cursor Cloud): only listed once configured.
  const remoteGroup = 'Remote agents'
  for (const remote of REMOTE_AGENT_MODELS) {
    // RemoteAgentProvider is a single-member union today, so this discriminator is
    // always true per types; it stays so future providers gate on their own key.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (remote.provider === REMOTE_AGENT_PROVIDER_CURSOR && isAvailable('cursor')) {
      options.push({ value: remote.value, label: remote.label, group: remoteGroup })
    }
  }

  // Local models: only listed when a local server is reachable and exposes some.
  const lmGroup = 'Local models'
  let models: string[]
  try {
    models = await api.lmStudio.models()
  } catch {
    models = []
  }
  for (const id of models) options.push({ value: `lmstudio:${id}`, label: id, group: lmGroup })

  if (current && !options.some((o) => o.value === current)) {
    if (current.startsWith('lmstudio:')) {
      options.push({
        value: current,
        label: `${current.slice('lmstudio:'.length)} (offline)`,
        group: lmGroup,
      })
    } else if (current.startsWith(REMOTE_AGENT_MODEL_PREFIX)) {
      options.push({
        value: current,
        label: `${modelDisplayLabel(current)} (not configured)`,
        group: remoteGroup,
      })
    } else {
      options.push({ value: current, label: `${current} (no key)` })
    }
  }

  // Only when nothing at all is configured (no cloud key, no provider, no local
  // server) do we surface a single guiding message instead of an empty picker.
  if (options.length === 0) {
    options.push({
      value: '',
      label: 'No models available — add a provider or API key in Settings',
      disabled: true,
    })
  }

  return options
}

function opt(value: string, label: string, disabled = false): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  o.disabled = disabled
  return o
}

// Fill a <select> with the cloud models plus a local optgroup of the models the
// configured local server exposes (value `lmstudio:<id>`). Keeps the
// `current` value selectable even if the server is offline.
export async function populateModelSelect(
  select: HTMLSelectElement,
  api: ApiClient,
  current: string,
): Promise<void> {
  clear(select)
  const options = await fetchModelOptions(api, current)
  let lastGroup: string | undefined
  let groupEl: HTMLOptGroupElement | null = null
  for (const item of options) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      if (item.group) {
        groupEl = document.createElement('optgroup')
        groupEl.label = item.group
        select.append(groupEl)
      } else {
        groupEl = null
      }
    }
    const node = opt(item.value, item.label, item.disabled)
    if (groupEl) groupEl.append(node)
    else select.append(node)
  }
  select.value = current
}

/** Fill a <select> with local model ids for routing settings (blank = auto). */
export function populateLocalModelSelect(
  select: HTMLSelectElement,
  models: string[],
  current: string,
  autoLabel = '(auto — first loaded model)',
): void {
  clear(select)
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = autoLabel
  select.append(auto)
  for (const id of models) {
    const o = document.createElement('option')
    o.value = id
    o.textContent = id
    select.append(o)
  }
  select.value = current
}

/** Model picker for small tasks — cloud, local, or auto (empty value). */
export async function populateSmallTasksModelSelect(
  select: HTMLSelectElement,
  api: ApiClient,
  current: string,
): Promise<void> {
  clear(select)
  select.append(opt('', '(auto — prefer local, fall back to chat model)'))
  const options = await fetchModelOptions(api, current)
  let lastGroup: string | undefined
  let groupEl: HTMLOptGroupElement | null = null
  for (const item of options) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      if (item.group) {
        groupEl = document.createElement('optgroup')
        groupEl.label = item.group
        select.append(groupEl)
      } else {
        groupEl = null
      }
    }
    const node = opt(item.value, item.label, item.disabled)
    if (groupEl) groupEl.append(node)
    else select.append(node)
  }
  select.value = current
}
