import type { ApiClient } from '../../preload/api.d.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'

/** First-party credential surface for the direct Parallel Search integration. */
export function createParallelSearchPackSettings(api: ApiClient): HTMLElement {
  const root = document.createElement('div')
  root.className = 'parallel-search-pack-settings'

  const heading = document.createElement('div')
  heading.className = 'pack-settings-heading'
  heading.textContent = 'Credentials'

  const keys = createApiKeysSection(api, {
    legend: 'Parallel account',
    providers: ['parallel'],
    validateOnInput: false,
  })
  keys.root.classList.add('parallel-search-key-fieldset')

  const note = document.createElement('p')
  note.className = 'parallel-search-notice'
  note.textContent =
    'Copse calls api.parallel.ai directly—no MCP server. Search objectives and queries leave this device. Zero Data Retention is not implied by this switch; it must be enabled in your Parallel account or contract.'

  const saveButton = document.createElement('button')
  saveButton.type = 'button'
  saveButton.className = 'parallel-search-save-btn'
  saveButton.textContent = 'Save API key'
  saveButton.addEventListener('click', () => {
    saveButton.disabled = true
    void keys.saveKeys().finally(() => {
      saveButton.disabled = false
    })
  })

  const clearButton = document.createElement('button')
  clearButton.type = 'button'
  clearButton.className = 'parallel-search-clear-btn'
  clearButton.textContent = 'Clear saved key'
  clearButton.addEventListener('click', () => {
    clearButton.disabled = true
    void api.settings
      .setKey('parallel', '')
      .then(() => keys.refreshKeyStatus())
      .finally(() => {
        clearButton.disabled = false
      })
  })

  const actions = document.createElement('div')
  actions.className = 'parallel-search-actions'
  actions.append(saveButton, clearButton)

  root.append(heading, keys.root, note, actions)
  void keys.refreshKeyStatus()
  return root
}
