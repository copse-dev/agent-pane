import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import {
  resolveWebSearchProvider,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_LABELS,
} from '@shared/web-search.ts'
import { el } from '../../dom/helpers.ts'
import { createApiKeysSection } from '../setup/api-keys-section.ts'

export function createWebSearchSection(api: ApiClient): {
  root: HTMLElement
  refresh: (snapshot: SettingsSnapshot, signal: AbortSignal) => Promise<void>
  collect: (dirty: ReadonlySet<string>) => SettingsUpdate
  saveKeys: () => Promise<boolean>
  reset: () => void
} {
  const provider = el('select', { name: 'webSearchProvider' })
  for (const value of WEB_SEARCH_PROVIDERS) {
    provider.append(el('option', { value }, WEB_SEARCH_LABELS[value]))
  }
  const tavily = createApiKeysSection(api, {
    legend: 'Tavily account',
    providers: ['tavily'],
    validateOnInput: false,
  })
  const parallel = createApiKeysSection(api, {
    legend: 'Parallel account',
    providers: ['parallel'],
    validateOnInput: false,
  })
  const note = el(
    'p',
    { class: 'field-hint' },
    'Queries and returned excerpts are included in the conversation. Provider retention and usage terms apply. Saving credentials does not run a search.',
  )
  const root = el(
    'fieldset',
    {},
    el('legend', {}, 'Search provider'),
    el('label', {}, 'Default provider', provider),
    tavily.root,
    parallel.root,
    note,
  )
  const sync = (): void => {
    tavily.root.hidden = provider.value !== 'tavily'
    parallel.root.hidden = provider.value !== 'parallel'
  }
  provider.addEventListener('change', sync)
  provider.value = 'none'
  sync()
  return {
    root,
    refresh: async (snapshot, signal): Promise<void> => {
      if (signal.aborted) return
      provider.value = resolveWebSearchProvider(snapshot.webSearchProvider)
      sync()
      await Promise.all([tavily.refreshKeyStatus(signal), parallel.refreshKeyStatus(signal)])
    },
    collect: (dirty): SettingsUpdate =>
      dirty.has('webSearchProvider')
        ? { webSearchProvider: resolveWebSearchProvider(provider.value) }
        : {},
    saveKeys: async (): Promise<boolean> => {
      // Save only the selected account; switching providers must not save a hidden draft key.
      if (provider.value === 'tavily') return tavily.saveKeys()
      if (provider.value === 'parallel') return parallel.saveKeys()
      return true
    },
    reset: (): void => {
      tavily.reset()
      parallel.reset()
    },
  }
}
