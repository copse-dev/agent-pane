import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  ClassifierClient,
  ClassifierProfile,
  ClassifierProfileStatus,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import { CLASSIFIER_PRESETS, classifierCredentialId } from '@copse/llm/classifiers/presets.ts'
import { el, clear } from '../../dom/helpers.ts'
import { disclosureSummary } from '../../dom/disclosure-summary.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import { errorMessage } from '@shared/errors.ts'

interface ClassifiersSectionApi {
  classifiers: ClassifierClient
  settings: Pick<ApiClient['settings'], 'setKey'>
}

export interface ClassifiersSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

function classifierErrorMessage(error: unknown): string {
  const message = errorMessage(error).replace(
    /^(?:Error invoking remote method '[^']+':\s*|(?:ClassifierError|Error):\s*)+/,
    '',
  )
  if (message.startsWith('IpcValidationError:')) {
    return 'The supplied settings are invalid. Check the field values and try again.'
  }
  return message || 'Classifier request failed.'
}

/** A select choice: the stored enum value and the words shown for it. */
interface SelectChoice {
  value: string
  label: string
}

// The stored values are wire enums; the labels are what a person reads.
const PROTOCOL_CHOICES: readonly SelectChoice[] = [
  { value: 'systemone', label: 'SystemOne' },
  { value: 'featherless', label: 'Featherless classifier' },
]
const AUTH_CHOICES: readonly SelectChoice[] = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer token (API key)' },
]
const BACKEND_CHOICES: readonly SelectChoice[] = [
  { value: 'torch', label: 'PyTorch' },
  { value: 'mlx', label: 'MLX' },
  { value: 'llamacpp', label: 'llama.cpp (GGUF)' },
]
const MODE_CHOICES: readonly SelectChoice[] = [
  { value: 'direct', label: 'Direct' },
  { value: 'serial', label: 'Serial' },
  { value: 'shared', label: 'Shared' },
]

function describeResult(result: ClassifierResult): string {
  const answers = Object.entries(result.answers).map(([id, answer]) => {
    switch (answer.type) {
      case 'choice':
        return `${id}: ${answer.choice}`
      case 'boolean':
        return `${id}: ${(answer.probability * 100).toFixed(1)}% probability`
      case 'score':
        return `${id}: ${String(answer.score)}`
    }
  })
  return `${answers.join(' · ')} · ${String(Math.round(result.elapsedMs))} ms · ${result.model}`
}

/** Explicitly saved connections; opening settings never makes an inference call. */
export function createClassifiersSection(api: ClassifiersSectionApi): ClassifiersSection {
  const chips = el('div', { class: 'provider-chips', 'aria-label': 'Classifier profiles' })
  const formHost = el('div', { class: 'provider-form-host' })
  const status = el('p', { class: 'classifier-status', role: 'status', 'aria-live': 'polite' })
  const root = el(
    'fieldset',
    { class: 'classifiers-section' },
    el('legend', {}, 'Classifier connections'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Connect local or hosted classifiers for evals and explicit calls. Save a connection, then use Test classifier to send a small sample. Hosted tests may incur a charge.',
    ),
    chips,
    formHost,
    status,
  )
  let profiles: ClassifierProfileStatus[] = []
  let selectedId: string | null = null
  const drafts = new Map<string, ClassifierProfile>()
  let captureDraft: (() => void) | undefined
  const pending = new Map<string, Map<string, string>>()
  let busy = false

  function renderChips(): void {
    clear(chips)
    const items = [...profiles.map((item) => item.profile), ...drafts.values()].filter(
      (profile, index, all) => all.findIndex((item) => item.id === profile.id) === index,
    )
    for (const profile of items) {
      const chip = el(
        'button',
        {
          type: 'button',
          class: 'provider-chip',
          'aria-pressed': String(profile.id === selectedId),
          'data-classifier-id': profile.id,
        },
        profile.label,
      )
      chip.classList.toggle('active', profile.id === selectedId)
      chip.addEventListener('click', () => {
        if (busy) return
        captureDraft?.()
        selectedId = profile.id
        render()
      })
      chips.append(chip)
    }
    const add = el(
      'button',
      { type: 'button', class: 'provider-chip classifier-add' },
      '+ Add classifier',
    )
    add.classList.toggle('active', selectedId === null)
    add.addEventListener('click', () => {
      if (busy) return
      captureDraft?.()
      selectedId = null
      render()
    })
    chips.append(add)
  }

  function render(): void {
    renderChips()
    clear(formHost)
    clear(status)
    captureDraft = undefined
    const saved = profiles.find((item) => item.profile.id === selectedId)
    const profile = saved?.profile ?? drafts.get(selectedId ?? '')
    if (!profile) {
      const presets = el('select', { name: 'classifierPreset' })
      for (const preset of CLASSIFIER_PRESETS) {
        presets.append(el('option', { value: preset.id }, preset.label))
      }
      presets.append(el('option', { value: 'custom' }, 'Custom compatible endpoint'))
      const add = el(
        'button',
        { type: 'button', class: 'classifier-create' },
        'Configure classifier',
      )
      add.addEventListener('click', () => {
        const preset = CLASSIFIER_PRESETS.find((item) => item.id === presets.value)
        const id = `${preset?.id ?? 'custom'}-${crypto.randomUUID().slice(0, 8)}`
        const draft: ClassifierProfile = preset
          ? { ...preset, id, connection: { ...preset.connection } }
          : {
              id,
              label: 'Custom classifier',
              model: '',
              timeoutMs: 30_000,
              connection: { type: 'http', protocol: 'systemone', baseUrl: '', auth: 'bearer' },
            }
        drafts.set(id, draft)
        selectedId = id
        render()
      })
      formHost.append(
        el(
          'div',
          { class: 'provider-form' },
          el('label', {}, 'Provider', presets),
          el('div', { class: 'provider-actions' }, add),
        ),
      )
      return
    }

    const values = pending.get(profile.id) ?? new Map<string, string>()
    const controls = new Map<string, HTMLInputElement | HTMLSelectElement>()
    function input(name: string, value: string, type = 'text'): HTMLInputElement {
      const control = el('input', { type, name: `classifier${name}`, autocomplete: 'off' })
      control.value = values.get(name) ?? value
      controls.set(name, control)
      return control
    }
    function select(
      name: string,
      value: string,
      choices: readonly SelectChoice[],
    ): HTMLSelectElement {
      const control = el('select', { name: `classifier${name}` })
      for (const choice of choices) {
        control.append(el('option', { value: choice.value }, choice.label))
      }
      control.value = values.get(name) ?? value
      controls.set(name, control)
      return control
    }
    captureDraft = (): void => {
      for (const [name, control] of controls) values.set(name, control.value)
      pending.set(profile.id, values)
    }
    const label = input('Label', profile.label)
    const model = input('Model', profile.model)
    const timeout = input('Timeout', String(profile.timeoutMs / 1000), 'number')
    timeout.min = '0.1'
    timeout.step = '0.001'
    timeout.max = '600'
    const form = el(
      'div',
      { class: 'provider-form classifier-form' },
      el('label', {}, 'Connection name', label),
      el('label', {}, 'Model ID', model),
      el('span', { class: 'field-hint' }, 'Profile ID for evals: ', el('code', {}, profile.id)),
    )
    const read = (name: string): string => controls.get(name)?.value.trim() ?? ''
    const advanced = el(
      'details',
      { class: 'provider-advanced' },
      disclosureSummary('Connection options'),
    )
    let key: HTMLInputElement | undefined
    let removeKey: HTMLInputElement | undefined
    if (profile.connection.type === 'http') {
      const connection = profile.connection
      const protocol = select('Protocol', connection.protocol, PROTOCOL_CHOICES)
      const url = input('Url', connection.baseUrl, 'url')
      const auth = select('Auth', connection.auth, AUTH_CHOICES)
      const env = input('KeyEnv', connection.apiKeyEnv ?? '')
      key = input('Key', '', 'password')
      const destinationNote = el('span', {
        class: 'field-hint classifier-destination-note',
        hidden: true,
      })
      function normalizedUrl(value: string): string {
        try {
          return new URL(value).href.replace(/\/+$/, '')
        } catch {
          return value.trim().replace(/\/+$/, '')
        }
      }
      const updateDestinationNote = (): void => {
        destinationNote.hidden =
          !saved ||
          (normalizedUrl(url.value) === normalizedUrl(connection.baseUrl) &&
            protocol.value === connection.protocol &&
            auth.value === connection.auth)
        if (key) {
          key.placeholder = !destinationNote.hidden
            ? 'Enter a key for the new connection'
            : saved?.hasKey
              ? saved.encrypted === null
                ? 'Leave blank to use the environment key'
                : 'Leave blank to keep the saved key'
              : 'API key'
        }
        destinationNote.textContent =
          auth.value === 'bearer'
            ? 'Saving this connection change removes any saved key. Enter a replacement key or name an environment variable before testing.'
            : 'Saving this connection change removes any saved key.'
      }
      url.addEventListener('input', updateDestinationNote)
      url.addEventListener('change', updateDestinationNote)
      protocol.addEventListener('change', updateDestinationNote)
      auth.addEventListener('change', updateDestinationNote)
      updateDestinationNote()

      const keyStatus = el(
        'span',
        { class: 'field-hint classifier-key-status' },
        saved?.hasKey
          ? saved.encrypted === true
            ? 'Key saved · encrypted by OS keychain'
            : saved.encrypted === false
              ? 'Key saved · stored unencrypted'
              : 'Key available from environment'
          : 'No key saved',
      )
      removeKey = el('input', { type: 'checkbox', name: 'classifierRemoveKey' })
      removeKey.checked = values.get('RemoveKey') === 'true'
      const remove = el('label', { class: 'checkbox-label' }, removeKey, ' Remove saved key')
      remove.hidden = !saved?.hasKey || saved.encrypted === null
      removeKey.addEventListener('change', () =>
        values.set('RemoveKey', String(removeKey?.checked)),
      )
      const credentials = el(
        'div',
        { class: 'provider-field-group classifier-credentials' },
        el('label', {}, 'API key', key),
        keyStatus,
        remove,
      )
      const envField = el(
        'label',
        {},
        'Environment variable (optional)',
        env,
        el(
          'span',
          { class: 'field-hint' },
          'Custom connections use COPSE_CLASSIFIER_* variables. TYPESAFE_API_KEY and FEATHERLESS_API_KEY work only with their matching official endpoints. Leave blank to use a saved key.',
        ),
      )
      const updateAuth = (): void => {
        envField.hidden = auth.value !== 'bearer'
        credentials.hidden = auth.value !== 'bearer'
      }
      auth.addEventListener('change', updateAuth)
      updateAuth()
      form.append(el('label', {}, 'Base URL', url), destinationNote, credentials)
      advanced.append(
        el('label', {}, 'API protocol', protocol),
        el('label', {}, 'Authentication', auth),
        envField,
      )
    } else {
      const connection = profile.connection
      const backend = select('Backend', connection.backend, BACKEND_CHOICES)
      const gguf = el('label', {}, 'GGUF model path', input('Gguf', connection.gguf ?? ''))
      const updateBackend = (): void => {
        gguf.hidden = backend.value !== 'llamacpp'
      }
      backend.addEventListener('change', updateBackend)
      updateBackend()
      form.append(el('label', {}, 'Scorer executable', input('Executable', connection.executable)))
      advanced.append(
        el('label', {}, 'Backend', backend),
        el('label', {}, 'Model revision', input('Revision', connection.revision)),
        el('label', {}, 'Scoring mode', select('Mode', connection.mode, MODE_CHOICES)),
        gguf,
        el(
          'span',
          { class: 'field-hint' },
          'Uses your installed SemIf scorer and cached or local weights. Test does not install a runtime or download models.',
        ),
      )
    }
    advanced.append(el('label', {}, 'Timeout (seconds)', timeout))
    form.append(advanced)
    const save = el('button', { type: 'button', class: 'classifier-save' }, 'Save classifier')
    const test = el(
      'button',
      { type: 'button', class: 'classifier-test', disabled: !saved },
      'Test classifier',
    )
    const remove = el(
      'button',
      { type: 'button', class: 'classifier-remove' },
      saved ? 'Remove classifier' : 'Discard draft',
    )
    const actions = el('div', { class: 'provider-actions' }, save, test, remove)
    form.append(actions)
    formHost.append(form)

    function edited(): boolean {
      return (
        [...controls].some(([name, control]) => control.value !== values.get(`saved:${name}`)) ||
        removeKey?.checked === true
      )
    }
    for (const [name, control] of controls) {
      // Saved values describe the loaded profile, not an unsaved draft restored from a tab.
      const initial = name === 'Key' ? '' : control.value
      if (!values.has(`saved:${name}`)) values.set(`saved:${name}`, initial)
      control.addEventListener('input', () => {
        clear(status)
        captureDraft?.()
        test.disabled = !saved || edited()
      })
      control.addEventListener('change', () => {
        clear(status)
        captureDraft?.()
        test.disabled = !saved || edited()
      })
    }
    removeKey?.addEventListener('change', () => {
      test.disabled = !saved || edited()
    })
    test.disabled = !saved || edited()
    test.title = 'Tests the saved connection. Save edits first.'

    async function run(action: () => Promise<void>): Promise<void> {
      if (busy) return
      busy = true
      root.disabled = true
      save.disabled = test.disabled = remove.disabled = true
      try {
        await action()
      } catch (error) {
        setInlineStatus(status, 'error', classifierErrorMessage(error))
      } finally {
        busy = false
        root.disabled = false
        save.disabled = remove.disabled = false
        test.disabled = !saved || edited()
      }
    }
    save.addEventListener('click', () => {
      void run(async () => {
        captureDraft?.()
        const connection: ClassifierProfile['connection'] =
          profile.connection.type === 'http'
            ? {
                type: 'http',
                protocol: read('Protocol') === 'featherless' ? 'featherless' : 'systemone',
                baseUrl: read('Url'),
                auth: read('Auth') === 'none' ? 'none' : 'bearer',
                ...(read('KeyEnv') ? { apiKeyEnv: read('KeyEnv') } : {}),
              }
            : {
                type: 'semif',
                executable: read('Executable'),
                ...(profile.connection.device ? { device: profile.connection.device } : {}),
                ...(profile.connection.maxTokens
                  ? { maxTokens: profile.connection.maxTokens }
                  : {}),
                backend:
                  read('Backend') === 'mlx'
                    ? 'mlx'
                    : read('Backend') === 'llamacpp'
                      ? 'llamacpp'
                      : 'torch',
                revision: read('Revision'),
                mode:
                  read('Mode') === 'serial'
                    ? 'serial'
                    : read('Mode') === 'shared'
                      ? 'shared'
                      : 'direct',
                ...(read('Backend') === 'llamacpp' && read('Gguf') ? { gguf: read('Gguf') } : {}),
              }
        const next: ClassifierProfile = {
          id: profile.id,
          label: read('Label'),
          model: read('Model'),
          timeoutMs: Math.round(Number(read('Timeout')) * 1000),
          connection,
        }
        profiles = await api.classifiers.save(next)
        // From here the connection exists on disk, including when credential storage fails.
        selectedId = profile.id
        drafts.delete(profile.id)
        let keyError: string | null = null
        const enteredKey = key?.value.trim() ?? ''
        const removingKey = removeKey?.checked === true
        // Keys are never included in the connection payload. Only the secure-key IPC sees them.
        if (enteredKey || removingKey) {
          const secret = removingKey ? '' : enteredKey
          try {
            let result = await api.settings.setKey(classifierCredentialId(profile.id), secret)
            if (!result.ok && result.reason === 'plaintext-consent-required') {
              const approved = await showConfirmDialog({
                message: `No OS keyring is available to encrypt the key for ${next.label}.`,
                detail: 'Store it unencrypted on this machine anyway?',
                confirmLabel: 'Store anyway',
              })
              if (approved)
                result = await api.settings.setKey(classifierCredentialId(profile.id), secret, {
                  allowPlaintext: true,
                })
            }
            if (!result.ok) {
              keyError =
                result.reason === 'plaintext-storage-disabled'
                  ? 'Connection saved; key not saved because secure storage is unavailable and plaintext storage is disabled.'
                  : 'Connection saved; key not saved because unencrypted storage was declined.'
            }
          } catch (error) {
            keyError = `Connection saved; key save failed: ${classifierErrorMessage(error)}`
          }
        }
        // Reset saved-field baselines to the persisted profile; preserve only the failed key edit.
        pending.delete(profile.id)
        if (keyError) {
          pending.set(
            profile.id,
            new Map([
              ['Key', enteredKey],
              ['RemoveKey', String(removingKey)],
            ]),
          )
        }
        let refreshError: string | null = null
        try {
          profiles = await api.classifiers.list()
        } catch (error) {
          refreshError = `Connection saved; could not refresh key status: ${classifierErrorMessage(error)}`
        }
        render()
        const failure = keyError ?? refreshError
        setInlineStatus(
          status,
          failure ? 'error' : 'ok',
          failure ?? 'Classifier saved. No test call has been made.',
        )
      })
    })
    test.addEventListener('click', () => {
      void run(async () => {
        setInlineStatus(status, 'pending', 'Testing saved classifier…')
        const result = await api.classifiers.test(profile.id)
        setInlineStatus(status, 'ok', `Test succeeded · ${describeResult(result)}`)
      })
    })
    remove.addEventListener('click', () => {
      void run(async () => {
        if (saved) profiles = await api.classifiers.remove(profile.id)
        pending.delete(profile.id)
        selectedId = profiles[0]?.profile.id ?? null
        drafts.delete(profile.id)
        render()
        setInlineStatus(
          status,
          'ok',
          saved ? 'Classifier and its saved key removed.' : 'Draft discarded.',
        )
      })
    })
  }

  async function refresh(): Promise<void> {
    if (busy) return
    captureDraft?.()
    try {
      profiles = await api.classifiers.list()
      selectedId ??= profiles[0]?.profile.id ?? null
      if (
        selectedId !== null &&
        !drafts.has(selectedId) &&
        !profiles.some((item) => item.profile.id === selectedId)
      )
        selectedId = null
      render()
    } catch (error) {
      setInlineStatus(status, 'error', classifierErrorMessage(error))
    }
  }
  render()
  return { root, refresh }
}
