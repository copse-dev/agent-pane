import type { ApiClient } from '../../preload/api.d.ts'
import { CLOUD_MODELS } from '@shared/llm/model-catalog.ts'
import { clear } from '../dom/helpers.ts'

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
  select.value = current
}

/** Model picker for background tasks — cloud, local, or auto (empty value). */
export async function populateBackgroundTasksModelSelect(
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
