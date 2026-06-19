import type { ApiClient } from '../../preload/api.d.ts'

// Cloud models, each tagged with the provider key it needs. They're only shown
// when that provider is available. LM Studio models are discovered at runtime.
export const CLOUD_MODELS: Array<[value: string, label: string, provider: 'anthropic' | 'openai']> =
  [
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', 'anthropic'],
    ['claude-opus-4-8', 'claude-opus-4-8', 'anthropic'],
    ['gpt-4o', 'gpt-4o', 'openai'],
    ['gpt-4o-mini', 'gpt-4o-mini', 'openai'],
  ]

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
  select.innerHTML = ''

  // Only show cloud models whose provider has a key (stored or in env).
  let available = { anthropic: true, openai: true }
  try {
    available = await api.settings.availableProviders()
  } catch {
    /* keep defaults */
  }
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (available[provider]) select.append(opt(value, label))
  }

  const group = document.createElement('optgroup')
  group.label = 'LM Studio (local)'
  let models: string[] = []
  try {
    models = await api.lmStudio.models()
  } catch {
    models = []
  }
  if (models.length) {
    for (const id of models) group.append(opt(`lmstudio:${id}`, id))
  } else {
    group.append(opt('', 'Not connected — configure in Settings', true))
  }
  select.append(group)

  // If the saved model is an LM Studio model the server didn't return (offline),
  // still show it so the selection isn't silently lost.
  if (current && !Array.from(select.options).some((o) => o.value === current)) {
    if (current.startsWith('lmstudio:')) {
      group.append(opt(current, `${current.slice('lmstudio:'.length)} (offline)`))
    } else {
      // A cloud model whose provider key is missing — still show the active
      // selection (marked) so it isn't silently lost.
      select.append(opt(current, `${current} (no key)`))
    }
  }
  select.value = current
}
