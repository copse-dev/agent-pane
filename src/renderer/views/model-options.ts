import type { ApiClient } from '../../preload/api.d.ts'
import { clear } from '../dom/helpers.ts'

// Cloud models, each tagged with the provider key it needs. They're only shown
// when that provider is available. LM Studio models are discovered at runtime.
export const CLOUD_MODELS: Array<[value: string, label: string, provider: 'anthropic' | 'openai']> =
  [
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', 'anthropic'],
    ['claude-opus-4-8', 'claude-opus-4-8', 'anthropic'],
    ['gpt-4o', 'gpt-4o', 'openai'],
    ['gpt-4o-mini', 'gpt-4o-mini', 'openai'],
  ]

export interface ModelOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

export function modelDisplayLabel(model: string): string {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  return model
}

export async function fetchModelOptions(api: ApiClient, current: string): Promise<ModelOption[]> {
  const options: ModelOption[] = []

  let available = { anthropic: true, openai: true }
  try {
    available = await api.settings.availableProviders()
  } catch {
    /* keep defaults */
  }
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (available[provider]) options.push({ value, label })
  }

  const lmGroup = 'LM Studio (local)'
  let models: string[] = []
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

// Fill a <select> with the cloud models plus an "LM Studio" optgroup of the
// models the local server actually exposes (value `lmstudio:<id>`). Keeps the
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

/** Fill a <select> with LM Studio model ids for routing settings (blank = auto). */
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
  if (current && !models.includes(current)) {
    const o = document.createElement('option')
    o.value = current
    o.textContent = `${current} (offline)`
    select.append(o)
  }
  select.value = current
}
