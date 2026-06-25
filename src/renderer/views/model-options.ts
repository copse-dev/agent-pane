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
    return REMOTE_AGENT_MODELS.find((option) => option.provider === remoteProvider)?.label ?? model
  }
  return model
}

// OpenRouter's free, tool-capable models fetched live from its catalog, plus any
// custom id the user saved (or currently has selected — which may be a paid id).
// When no key is configured we show a single disabled hint instead of fetching.
async function openRouterOptions(
  api: ApiClient,
  available: boolean,
  current: string,
): Promise<ModelOption[]> {
  if (!available) {
    return [
      {
        value: '',
        label: 'Add an OpenRouter API key in Settings',
        group: OPENROUTER_GROUP,
        disabled: true,
      },
    ]
  }

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
  const add = (id: string, label: string) => {
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
// DeepSeek). Unlike OpenRouter there is no live catalog, so the shortlist comes
// from the registry; the currently-selected id is kept selectable even if it
// isn't in the shortlist. When no key is configured we show a disabled hint.
function extraProviderOptions(
  provider: ExtraProvider,
  available: boolean,
  current: string,
): ModelOption[] {
  if (!available) {
    return [
      {
        value: '',
        label: `Add a ${provider.label} API key in Settings`,
        group: provider.label,
        disabled: true,
      },
    ]
  }

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string) => {
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
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (isAvailable(provider)) options.push({ value, label })
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

  const remoteGroup = 'Remote agents'
  for (const remote of REMOTE_AGENT_MODELS) {
    if (remote.provider === REMOTE_AGENT_PROVIDER_CURSOR) {
      options.push(
        isAvailable('cursor')
          ? { value: remote.value, label: remote.label, group: remoteGroup }
          : {
              value: remote.value,
              label: `${remote.label} — configure Cursor API key`,
              group: remoteGroup,
              disabled: true,
            },
      )
      continue
    }
  }

  const lmGroup = 'Local models'
  let models: string[]
  try {
    models = await api.lmStudio.models()
  } catch {
    models = []
  }
  if (models.length) {
    for (const id of models) options.push({ value: `lmstudio:${id}`, label: id, group: lmGroup })
  } else {
    options.push({
      value: '',
      label: 'Not connected — configure in Settings',
      group: lmGroup,
      disabled: true,
    })
  }

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
