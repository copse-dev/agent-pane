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
    // At-rest storage badge, shown next to the key once one is saved: whether the
    // stored key is OS-encrypted or fell back to base64 plaintext on disk.
    const atRest = el('span', { class: 'key-status', 'data-at-rest': provider })
    const label = el(
      'label',
      {},
      config.label,
      input,
      status,
      atRest,
      el('span', { class: 'field-hint' }, config.hint),
    )
    return { ...config, input, status, atRest, label }
  })

  // Fieldset-level guidance shown only when at least one stored key is at rest as
  // plaintext (OS keyring unavailable). Hidden otherwise.
  const plaintextNote = el(
    'p',
    { class: 'field-hint', 'data-at-rest-note': '', hidden: true },
    'One or more keys are stored unencrypted because the OS secure storage is unavailable. Install and unlock a system keyring to encrypt them at rest.',
  )

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, legend),
    ...fields.map((field) => field.label),
    plaintextNote,
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
    let anyPlaintext = false
    for (const field of fields) {
      const saved = await api.settings.getKey(field.provider)
      if (!field.input.value.trim()) {
        setInlineStatus(field.status, saved ? 'filled' : 'pending', saved ? 'saved' : 'not set')
        field.status.className = 'key-status'
      }
      // At-rest badge: only meaningful once a key is stored. `null` means no key.
      const encrypted = saved ? await api.settings.getKeyEncrypted(field.provider) : null
      if (encrypted === true) {
        setInlineStatus(field.atRest, 'ok', 'Encrypted by OS keychain')
        field.atRest.className = 'key-status'
      } else if (encrypted === false) {
        anyPlaintext = true
        setInlineStatus(field.atRest, 'warn', 'Stored unencrypted')
        field.atRest.className = 'key-status'
      } else {
        field.atRest.replaceChildren()
        field.atRest.className = 'key-status'
      }
    }
    plaintextNote.hidden = !anyPlaintext
  }

  // Explicit per-key consent to store unencrypted when no OS keyring is available.
  // Returns whether the user approved a plaintext write for this provider.
  function confirmPlaintextStorage(provider: ApiKeyProvider): boolean {
    const label = API_KEY_PROVIDER_CONFIGS[provider].label
    return confirm(
      `No OS keyring is available to encrypt your ${label} at rest. ` +
        'Install and unlock a system keyring to store it encrypted.\n\n' +
        'Store it unencrypted on this machine anyway?',
    )
  }

  async function saveKeys(): Promise<void> {
    for (const field of fields) {
      const key = field.input.value.trim()
      if (!key) {
        field.input.value = ''
        continue
      }
      let result = await api.settings.setKey(field.provider, key)
      // Not ok means `plaintext-consent-required`: OS secure storage is unavailable
      // and no consent was given yet. Ask before writing the key to disk in the
      // clear, and retry with explicit consent on approval.
      if (!result.ok && confirmPlaintextStorage(field.provider)) {
        result = await api.settings.setKey(field.provider, key, { allowPlaintext: true })
      }
      if (result.ok) {
        field.input.value = ''
      } else {
        // Declined (or still refused): leave the entered value in place and flag
        // that it was not saved so the user can retry or set up a keyring first.
        setInlineStatus(field.status, 'error', 'Not saved — unencrypted storage declined')
        field.status.className = keyStatusClass(false)
      }
    }
    await refreshKeyStatus()
  }

  return { root: fieldset, refreshKeyStatus, saveKeys }
}
