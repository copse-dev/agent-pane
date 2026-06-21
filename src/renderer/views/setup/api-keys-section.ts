import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'

export interface ApiKeysSection {
  root: HTMLFieldSetElement
  refreshKeyStatus: () => Promise<void>
  saveKeys: () => Promise<void>
}

function keyStatusClass(ok: boolean | null): string {
  if (ok === true) return 'key-status ok'
  if (ok === false) return 'key-status err'
  return 'key-status'
}

export function createApiKeysSection(
  api: ApiClient,
  opts: { legend?: string; validateOnInput?: boolean } = {},
): ApiKeysSection {
  const legend = opts.legend ?? 'API Keys'
  const validateOnInput = opts.validateOnInput ?? true

  const anthropicInput = el('input', {
    type: 'password',
    name: 'anthropicKey',
    placeholder: 'sk-ant-…',
    autocomplete: 'off',
  }) as HTMLInputElement
  const anthropicStatus = el('span', { class: 'key-status', 'data-key': 'anthropic' })
  const openaiInput = el('input', {
    type: 'password',
    name: 'openaiKey',
    placeholder: 'sk-…',
    autocomplete: 'off',
  }) as HTMLInputElement
  const openaiStatus = el('span', { class: 'key-status', 'data-key': 'openai' })

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, legend),
    el(
      'label',
      {},
      'Anthropic API key',
      anthropicInput,
      anthropicStatus,
      el(
        'span',
        { class: 'field-hint' },
        'For Claude Sonnet and Opus. Validated via a free models request — no tokens charged.',
      ),
    ),
    el(
      'label',
      {},
      'OpenAI API key',
      openaiInput,
      openaiStatus,
      el(
        'span',
        { class: 'field-hint' },
        'For GPT-4o models. Validated via a free models request — no tokens charged.',
      ),
    ),
  ) as HTMLFieldSetElement

  const validationTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async function validateField(
    provider: 'anthropic' | 'openai',
    input: HTMLInputElement,
    statusEl: HTMLElement,
  ): Promise<void> {
    const value = input.value.trim()
    if (!value) {
      statusEl.textContent = ''
      statusEl.className = 'key-status'
      return
    }
    statusEl.textContent = 'Checking…'
    statusEl.className = 'key-status'
    const result = await api.settings.validateKey(provider, value)
    if (result.ok) {
      statusEl.textContent = '✓ Valid key'
      statusEl.className = keyStatusClass(true)
    } else {
      statusEl.textContent = `✗ ${result.error ?? 'Invalid key'}`
      statusEl.className = keyStatusClass(false)
    }
  }

  function bindValidation(
    provider: 'anthropic' | 'openai',
    input: HTMLInputElement,
    statusEl: HTMLElement,
  ): void {
    if (!validateOnInput) return
    input.addEventListener('input', () => {
      const existing = validationTimers.get(provider)
      if (existing) clearTimeout(existing)
      validationTimers.set(
        provider,
        setTimeout(() => {
          void validateField(provider, input, statusEl)
        }, 500),
      )
    })
  }

  bindValidation('anthropic', anthropicInput, anthropicStatus)
  bindValidation('openai', openaiInput, openaiStatus)

  async function refreshKeyStatus(): Promise<void> {
    const anthSet = await api.settings.getKey('anthropic')
    const openSet = await api.settings.getKey('openai')
    if (!anthropicInput.value.trim()) {
      anthropicStatus.textContent = anthSet ? '● saved' : '○ not set'
      anthropicStatus.className = 'key-status'
    }
    if (!openaiInput.value.trim()) {
      openaiStatus.textContent = openSet ? '● saved' : '○ not set'
      openaiStatus.className = 'key-status'
    }
  }

  async function saveKeys(): Promise<void> {
    const anthKey = anthropicInput.value.trim()
    const openKey = openaiInput.value.trim()
    if (anthKey) await api.settings.setKey('anthropic', anthKey)
    if (openKey) await api.settings.setKey('openai', openKey)
    anthropicInput.value = ''
    openaiInput.value = ''
    await refreshKeyStatus()
  }

  return { root: fieldset, refreshKeyStatus, saveKeys }
}
