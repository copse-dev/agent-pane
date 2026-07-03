import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'

// Fixed cloud providers with bespoke key validation. OpenAI-compatible presets
// (Mistral/Gemini/DeepSeek) and user customs are managed in the separate
// custom-providers section, not here.
export type ApiKeyProvider = 'anthropic' | 'openai' | 'cursor' | 'openrouter' | 'github'

export interface ApiKeysSection {
  root: HTMLFieldSetElement
  refreshKeyStatus: () => Promise<void>
  saveKeys: () => Promise<void>
}

interface ApiKeyProviderConfig {
  provider: ApiKeyProvider
  name: string
  label: string
  placeholder: string
  hint: string
}

const API_KEY_PROVIDER_CONFIGS: Record<ApiKeyProvider, ApiKeyProviderConfig> = {
  anthropic: {
    provider: 'anthropic',
    name: 'anthropicKey',
    label: 'Anthropic API key',
    placeholder: 'sk-ant-…',
    hint: 'For Claude Sonnet and Opus. Validated via a free models request — no tokens charged.',
  },
  openai: {
    provider: 'openai',
    name: 'openaiKey',
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    hint: 'For GPT-4o models. Validated via a free models request — no tokens charged.',
  },
  cursor: {
    provider: 'cursor',
    name: 'cursorKey',
    label: 'Cursor API key',
    placeholder: 'cur_…',
    hint: 'For Cursor Cloud Agent remote runs. Validated via a free models request.',
  },
  openrouter: {
    provider: 'openrouter',
    name: 'openrouterKey',
    label: 'OpenRouter API key',
    placeholder: 'sk-or-…',
    hint: 'For OpenRouter models (Claude, GPT, Gemini, Llama, and more via one key). Validated via a free key request.',
  },
  github: {
    provider: 'github',
    name: 'githubKey',
    label: 'GitHub token',
    placeholder: 'github_pat_… or ghp_…',
    hint: 'For Claude Cloud Agent: clones the repo and pushes branches / opens PRs. Use a fine-grained token with repo scope.',
  },
}

function keyStatusClass(ok: boolean | null): string {
  if (ok === true) return 'key-status ok'
  if (ok === false) return 'key-status err'
  return 'key-status'
}

export function createApiKeysSection(
  api: ApiClient,
  opts: { legend?: string; providers?: ApiKeyProvider[]; validateOnInput?: boolean } = {},
): ApiKeysSection {
  const legend = opts.legend ?? 'API Keys'
  const providers = opts.providers ?? ['anthropic', 'openai', 'openrouter', 'cursor']
  const validateOnInput = opts.validateOnInput ?? true

  const fields = providers.map((provider) => {
    const config = API_KEY_PROVIDER_CONFIGS[provider]
    const input = el('input', {
      type: 'password',
      name: config.name,
      placeholder: config.placeholder,
      autocomplete: 'off',
    })
    const status = el('span', { class: 'key-status', 'data-key': provider })
    const label = el(
      'label',
      {},
      config.label,
      input,
      status,
      el('span', { class: 'field-hint' }, config.hint),
    )
    return { ...config, input, status, label }
  })

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, legend),
    ...fields.map((field) => field.label),
  )

  const validationTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async function validateField(
    provider: ApiKeyProvider,
    input: HTMLInputElement,
    statusEl: HTMLElement,
  ): Promise<void> {
    const value = input.value.trim()
    if (!value) {
      statusEl.replaceChildren()
      statusEl.className = 'key-status'
      return
    }
    setInlineStatus(statusEl, 'pending', 'Checking…')
    statusEl.className = 'key-status'
    const result = await api.settings.validateKey(provider, value)
    if (result.ok) {
      setInlineStatus(statusEl, 'ok', 'Valid key')
      statusEl.className = keyStatusClass(true)
    } else {
      setInlineStatus(statusEl, 'error', result.error ?? 'Invalid key')
      statusEl.className = keyStatusClass(false)
    }
  }

  function bindValidation(
    provider: ApiKeyProvider,
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

  for (const field of fields) {
    bindValidation(field.provider, field.input, field.status)
  }

  async function refreshKeyStatus(): Promise<void> {
    for (const field of fields) {
      const saved = await api.settings.getKey(field.provider)
      if (!field.input.value.trim()) {
        setInlineStatus(field.status, saved ? 'filled' : 'pending', saved ? 'saved' : 'not set')
        field.status.className = 'key-status'
      }
    }
  }

  async function saveKeys(): Promise<void> {
    for (const field of fields) {
      const key = field.input.value.trim()
      if (key) await api.settings.setKey(field.provider, key)
      field.input.value = ''
    }
    await refreshKeyStatus()
  }

  return { root: fieldset, refreshKeyStatus, saveKeys }
}
