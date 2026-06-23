import type { ApiClient } from '../../preload/api.d.ts'
import { CLOUD_MODELS } from '@shared/llm/model-catalog.ts'
import {
  OPENROUTER_MODELS,
  isOpenRouterModel,
  openRouterDisplayLabel,
  toOpenRouterModel,
} from '@shared/llm/openrouter.ts'
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
  const remoteProvider = parseRemoteAgentModel(model)
  if (remoteProvider) {
    return REMOTE_AGENT_MODELS.find((option) => option.provider === remoteProvider)?.label ?? model
  }
  return model
}

// Curated OpenRouter shortlist plus any custom id the user saved (or currently
// has selected). When no key is configured the entries show disabled, mirroring
// how the Cursor remote agent advertises itself before its key is set.
async function openRouterOptions(
  api: ApiClient,
  available: boolean,
  current: string,
): Promise<ModelOption[]> {
  let customId = ''
  try {
    customId = (((await api.settings.get('openRouterModel')) as string | null) ?? '').trim()
  } catch {
    /* no custom model configured */
  }

  const seen = new Set<string>()
  const entries: Array<{ value: string; label: string }> = []
  const add = (id: string, label: string) => {
    const value = toOpenRouterModel(id)
    if (!id || seen.has(value)) return
    seen.add(value)
    entries.push({ value, label })
  }

  for (const model of OPENROUTER_MODELS) add(model.id, model.label)
  if (customId) add(customId, `${customId} (custom)`)
  if (isOpenRouterModel(current))
    add(current.slice('openrouter:'.length), modelDisplayLabel(current))

  return entries.map((entry) =>
    available
      ? { value: entry.value, label: entry.label, group: OPENROUTER_GROUP }
      : {
          value: entry.value,
          label: `${entry.label} — configure OpenRouter API key`,
          group: OPENROUTER_GROUP,
          disabled: true,
        },
  )
}

export async function fetchModelOptions(api: ApiClient, current: string): Promise<ModelOption[]> {
  const options: ModelOption[] = []

  let available = { anthropic: true, openai: true, cursor: true, openrouter: true }
  try {
    available = await api.settings.availableProviders()
  } catch {
    /* keep defaults */
  }
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (available[provider]) options.push({ value, label })
  }

  options.push(...(await openRouterOptions(api, available.openrouter, current)))

  const remoteGroup = 'Remote agents'
  for (const remote of REMOTE_AGENT_MODELS) {
    if (remote.provider === REMOTE_AGENT_PROVIDER_CURSOR) {
      options.push(
        available.cursor
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
