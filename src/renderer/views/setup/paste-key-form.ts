import type { ApiClient } from '../../../preload/api.d.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import { PLAINTEXT_STORAGE_DISABLED_REASON } from './api-keys-section.ts'

// One "paste a key" box for every API-key provider. The provider is worked out
// from the key's prefix; when the prefix is shared (a bare `sk-`) or unknown the
// form asks, and an unknown key can fall through to the full "Other" form.

export interface DetectedKeyProvider {
  provider: string
  /** False when other providers issue keys with the same prefix. */
  certain: boolean
}

// Longest prefix first, so `sk-ant-` wins over `sk-`.
const KEY_PREFIXES: readonly { prefix: string; provider: string; certain: boolean }[] = [
  { prefix: 'sk-ant-', provider: 'anthropic', certain: true },
  { prefix: 'sk-or-', provider: 'openrouter', certain: true },
  { prefix: 'gsk_', provider: 'groq', certain: true },
  { prefix: 'AIza', provider: 'gemini', certain: true },
  { prefix: 'hf_', provider: 'huggingface', certain: true },
  { prefix: 'fw_', provider: 'fireworks', certain: true },
  { prefix: 'pplx-', provider: 'perplexity', certain: true },
  { prefix: 'cur_', provider: 'cursor', certain: true },
  // OpenAI-style keys, but DeepSeek and others also start `sk-`, so the user chooses.
  { prefix: 'sk-', provider: 'openai', certain: false },
]

const MIN_KEY_LENGTH = 8

/** Best guess at which provider issued `key`, or null when nothing matches. */
export function detectProviderFromKey(key: string): DetectedKeyProvider | null {
  const trimmed = key.trim()
  if (trimmed.length < MIN_KEY_LENGTH) return null
  const match = KEY_PREFIXES.find((entry) => trimmed.startsWith(entry.prefix))
  return match ? { provider: match.provider, certain: match.certain } : null
}

const OTHER = '__other'

export interface PasteKeyChoice {
  id: string
  label: string
}

export interface PasteKeyFormOptions {
  /** Providers offered when the key is not recognised. */
  providers: () => readonly PasteKeyChoice[]
  /** Called after a key is stored, so the host can refresh its status. */
  onSaved: () => void
  /** The full add form for a provider the user picks as "Other". */
  renderOther: () => HTMLElement
}

export interface PasteKeyForm {
  root: HTMLElement
  /** Rebuild the provider choices (the list changes as providers are added). */
  refreshChoices: () => void
  reset: () => void
}

export function createPasteKeyForm(api: ApiClient, opts: PasteKeyFormOptions): PasteKeyForm {
  const input = el('input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Paste an API key',
    'data-testid': 'paste-key-input',
  })
  const save = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-primary provider-save',
      'data-testid': 'paste-key-save',
    },
    'Save key',
  )
  save.disabled = true
  const hint = el('span', { class: 'field-hint', 'data-testid': 'paste-key-hint' })
  const picker = el('select', { 'data-testid': 'paste-key-provider' })
  const ask = el('div', { class: 'provider-actions', 'data-testid': 'paste-key-ask' }, picker)
  ask.hidden = true
  const otherHost = el('div', { class: 'provider-add-host', 'data-testid': 'paste-key-other' })
  otherHost.hidden = true

  const defaultHint =
    'Paste a key and Copse suggests its provider. Save checks the key with that provider, then stores it using your secure storage settings.'
  let guess: DetectedKeyProvider | null = null
  let chosen = ''
  let generation = 0
  let saving = false

  function label(id: string): string {
    return opts.providers().find((choice) => choice.id === id)?.label ?? id
  }

  function refreshChoices(): void {
    clear(picker)
    picker.append(el('option', { value: '' }, 'Choose a provider…'))
    for (const choice of opts.providers()) {
      picker.append(el('option', { value: choice.id }, choice.label))
    }
    picker.append(el('option', { value: OTHER }, 'Other (OpenAI-compatible)…'))
    picker.value = chosen
  }

  function setHint(text: string, kind: 'idle' | 'pending' | 'ok' | 'error' = 'idle'): void {
    if (kind === 'idle') hint.textContent = text
    else setInlineStatus(hint, kind, text)
    hint.className = kind === 'error' ? 'field-hint key-status err' : 'field-hint'
  }

  function askWhich(message: string): void {
    ask.hidden = false
    setHint(message)
  }

  function onInput(): void {
    const value = input.value.trim()
    save.disabled = value.length < MIN_KEY_LENGTH
    guess = detectProviderFromKey(value)
    chosen = ''
    picker.value = ''
    otherHost.hidden = true
    clear(otherHost)
    if (value.length < MIN_KEY_LENGTH) {
      ask.hidden = true
      setHint(defaultHint)
    } else if (guess && !guess.certain) {
      askWhich(
        'This prefix is shared by several providers. Choose its provider before checking the key.',
      )
    } else if (guess) {
      ask.hidden = true
      const name = label(guess.provider)
      setHint(`Looks like ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} key.`)
    } else {
      askWhich('Copse doesn’t recognise this key. Which provider is it for?')
    }
  }
  input.addEventListener('input', onInput)

  picker.addEventListener('change', () => {
    chosen = picker.value
    if (chosen === OTHER) {
      clear(otherHost)
      otherHost.append(opts.renderOther())
      otherHost.hidden = false
    } else {
      otherHost.hidden = true
    }
  })

  async function store(provider: string, key: string, mine: number): Promise<boolean> {
    let result = await api.settings.setKey(provider, key)
    if (!result.ok && result.reason === 'plaintext-consent-required') {
      const approved = await showConfirmDialog({
        message: `No OS keyring is available to encrypt your ${label(provider)} key at rest. Install and unlock a system keyring to store it encrypted.`,
        detail: 'Store it unencrypted on this machine anyway?',
        confirmLabel: 'Store anyway',
      })
      if (mine !== generation) return false
      if (approved) result = await api.settings.setKey(provider, key, { allowPlaintext: true })
    }
    if (result.ok) return true
    setHint(
      result.reason === 'plaintext-storage-disabled'
        ? `Not saved: ${PLAINTEXT_STORAGE_DISABLED_REASON}`
        : 'Not saved: unencrypted storage declined',
      'error',
    )
    return false
  }

  save.addEventListener('click', () => {
    void (async (): Promise<void> => {
      if (saving) return
      const mine = generation
      const key = input.value.trim()
      if (key.length < MIN_KEY_LENGTH) return
      const provider = chosen === OTHER ? '' : chosen || (guess?.certain ? guess.provider : '')
      if (!provider) {
        askWhich(
          chosen === OTHER
            ? 'Fill in the details below.'
            : 'Choose which provider this key is for.',
        )
        return
      }
      saving = true
      save.disabled = true
      input.disabled = true
      picker.disabled = true
      try {
        setHint(`Checking with ${label(provider)}…`, 'pending')
        const checked = await api.settings.validateKey(provider, key).catch(() => null)
        if (mine !== generation) return
        if (!checked?.ok) {
          save.disabled = false
          // A shared prefix is only a guess: a rejection means ask, not blame the key.
          if (guess && !guess.certain && !chosen) {
            askWhich(`${label(provider)} didn’t accept this key. Which provider is it for?`)
            return
          }
          setHint(checked?.error ?? `${label(provider)} didn’t accept this key.`, 'error')
          return
        }
        if (!(await store(provider, key, mine))) {
          save.disabled = false
          return
        }
        if (mine !== generation) return
        input.value = ''
        guess = null
        chosen = ''
        ask.hidden = true
        save.disabled = true
        setHint(`${label(provider)} key saved.`, 'ok')
        opts.onSaved()
      } catch {
        if (mine === generation) setHint('Could not save the key. Please try again.', 'error')
      } finally {
        saving = false
        input.disabled = false
        picker.disabled = false
        save.disabled = input.value.trim().length < MIN_KEY_LENGTH
      }
    })()
  })

  refreshChoices()
  setHint(defaultHint)
  const root = el(
    'div',
    { class: 'paste-key-form', 'data-testid': 'paste-key-form' },
    el('div', { class: 'provider-actions' }, input, save),
    hint,
    ask,
    otherHost,
  )
  function reset(): void {
    generation += 1
    input.value = ''
    onInput()
  }
  return { root, refreshChoices, reset }
}
