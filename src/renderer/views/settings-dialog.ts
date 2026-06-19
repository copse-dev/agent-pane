import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { populateLocalModelSelect, populateModelSelect } from './model-options.ts'
import { SETTINGS_DIALOG_HTML } from './settings-dialog-template.ts'

type SettingsSection = 'general' | 'local-models' | 'appearance'

type FieldCoerce = 'string' | 'number' | 'boolean'

interface SettingField {
  name: string
  coerce: FieldCoerce
  default: unknown
}

// Inputs/checkboxes that map 1:1 to a persisted setting. Loaded and saved by the
// generic helpers below so each field's default lives in exactly one place.
const INPUT_FIELDS: SettingField[] = [
  { name: 'lmStudioUrl', coerce: 'string', default: 'http://localhost:1234/v1' },
  { name: 'lmStudioForSmallTasks', coerce: 'boolean', default: true },
  { name: 'lmStudioSafetyEnabled', coerce: 'boolean', default: true },
  { name: 'autoRunSandboxCommands', coerce: 'boolean', default: true },
  { name: 'lmStudioSafetyConfidenceThreshold', coerce: 'number', default: 0.85 },
]

// Selects with dynamically-populated option lists. They're filled by the
// populate* helpers on open, but saved through the table as plain trimmed strings.
const SELECT_FIELD_NAMES = [
  'model',
  'lmStudioModel',
  'lmStudioSmallTasksModel',
  'lmStudioSafetyModel',
] as const

// API keys live behind a separate get/setKey API and are only overwritten when
// the user types a new value. `field` is the form control name; `provider` keys
// both the API calls and the `data-key` status indicator.
const API_KEYS = [
  { provider: 'anthropic', field: 'anthropicKey' },
  { provider: 'openai', field: 'openaiKey' },
  { provider: 'lmstudio', field: 'lmStudioKey' },
] as const

function fieldInput(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement
}

function applySettingToForm(form: HTMLFormElement, field: SettingField, value: unknown): void {
  const el = fieldInput(form, field.name)
  if (field.coerce === 'boolean') {
    el.checked = (value as boolean | undefined) ?? (field.default as boolean)
  } else {
    el.value = String(value ?? field.default)
  }
}

function readSettingFromForm(data: FormData, field: SettingField): unknown {
  if (field.coerce === 'boolean') return data.get(field.name) === 'on'
  if (field.coerce === 'number') {
    const n = parseFloat(data.get(field.name) as string)
    return Number.isFinite(n) ? n : field.default
  }
  return (data.get(field.name) as string).trim()
}

let overlayEl: HTMLElement | null = null

export function openSettingsDialog(): void {
  if (!overlayEl || !overlayEl.hidden) return
  overlayEl.hidden = false
  overlayEl.dispatchEvent(new Event('settings-open'))
}

export function closeSettingsDialog(): void {
  if (!overlayEl || overlayEl.hidden) return
  overlayEl.hidden = true
}

export function isSettingsDialogOpen(): boolean {
  return !!overlayEl && !overlayEl.hidden
}

export function mountSettingsDialog(store: AppStore, api: ApiClient): void {
  const overlay = document.createElement('div')
  overlay.id = 'settings-dialog'
  overlay.className = 'settings-overlay'
  overlay.hidden = true
  overlay.innerHTML = SETTINGS_DIALOG_HTML
  document.body.append(overlay)
  overlayEl = overlay

  const navBtns = overlay.querySelectorAll<HTMLButtonElement>('.settings-nav-btn')
  const sections = overlay.querySelectorAll<HTMLElement>('.settings-section')

  function showSection(id: SettingsSection): void {
    navBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.section === id))
    sections.forEach((sec) => sec.classList.toggle('active', sec.dataset.section === id))
  }

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.section as SettingsSection | undefined
      if (id) showSection(id)
    })
  })

  async function refreshLocalModelSelects(): Promise<void> {
    const form = overlay.querySelector('form') as HTMLFormElement
    let models: string[] = []
    try {
      models = await api.lmStudio.models()
    } catch {
      models = []
    }

    const lmModel = (await api.settings.get('lmStudioModel')) as string | undefined
    const lmSmall = (await api.settings.get('lmStudioSmallTasksModel')) as string | undefined
    const lmSafety = (await api.settings.get('lmStudioSafetyModel')) as string | undefined

    populateLocalModelSelect(
      form.elements.namedItem('lmStudioModel') as HTMLSelectElement,
      models,
      lmModel ?? '',
    )
    populateLocalModelSelect(
      form.elements.namedItem('lmStudioSmallTasksModel') as HTMLSelectElement,
      models,
      lmSmall ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      form.elements.namedItem('lmStudioSafetyModel') as HTMLSelectElement,
      models,
      lmSafety ?? '',
      '(auto — use default local model)',
    )
  }

  overlay.addEventListener('settings-open', () => {
    showSection('general')
    void (async () => {
      const form = overlay.querySelector('form') as HTMLFormElement

      // API key status indicators (● set / ○ not set)
      for (const { provider } of API_KEYS) {
        const set = await api.settings.getKey(provider)
        overlay.querySelector(`[data-key="${provider}"]`)!.textContent = set ? '● set' : '○ not set'
      }

      // Plain inputs/checkboxes — defaults come from the field table
      for (const field of INPUT_FIELDS) {
        applySettingToForm(form, field, await api.settings.get(field.name))
      }

      // Appearance settings are mirrored in the renderer store
      ;(form.elements.namedItem('theme') as HTMLSelectElement).value = store.getState().theme
      fieldInput(form, 'fontSize').value = String(store.getState().fontSize)

      // Dynamically-populated model selects
      const model = (await api.settings.get('model')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('model') as HTMLSelectElement,
        api,
        model ?? 'claude-sonnet-4-6',
      )
      await refreshLocalModelSelects()
    })()
  })

  overlay.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const form = overlay.querySelector('form') as HTMLFormElement
      const data = new FormData(form)

      // API keys — only overwrite when the user typed something
      for (const { provider, field } of API_KEYS) {
        const key = (data.get(field) as string).trim()
        if (key) await api.settings.setKey(provider, key)
      }

      // Dynamic model selects + plain inputs/checkboxes
      for (const name of SELECT_FIELD_NAMES) {
        await api.settings.set(name, (data.get(name) as string).trim())
      }
      for (const field of INPUT_FIELDS) {
        await api.settings.set(field.name, readSettingFromForm(data, field))
      }

      // Appearance settings persist and mirror into the renderer store
      const theme = data.get('theme') as 'light' | 'dark'
      const fontSize = parseInt(data.get('fontSize') as string, 10)
      const model = data.get('model') as string
      await api.settings.set('theme', theme)
      await api.settings.set('fontSize', fontSize)

      store.setState({ theme, fontSize, settings: { ...store.getState().settings, model } })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      document.documentElement.dataset.theme = theme
      closeSettingsDialog()
    })()
  })

  overlay.querySelector('#lmstudio-test-btn')!.addEventListener('click', () => {
    const form = overlay.querySelector('form') as HTMLFormElement
    const url = (form.elements.namedItem('lmStudioUrl') as HTMLInputElement).value.trim()
    const key = (form.elements.namedItem('lmStudioKey') as HTMLInputElement).value.trim()
    const statusEl = overlay.querySelector('#lmstudio-test-status') as HTMLElement
    statusEl.textContent = 'Testing…'
    statusEl.className = 'lmstudio-test-status'
    void api.lmStudio.test(url, key).then((r) => {
      if (r.ok) {
        const list =
          r.models && r.models.length ? r.models.slice(0, 3).join(', ') : 'no models loaded'
        statusEl.textContent = `✓ Connected — ${r.models?.length ?? 0} model(s): ${list}`
        statusEl.classList.add('ok')
        void refreshLocalModelSelects()
      } else {
        statusEl.textContent = `✗ ${r.error ?? 'Connection failed'}`
        statusEl.classList.add('err')
      }
    })
  })

  overlay.querySelector('#settings-cancel')!.addEventListener('click', closeSettingsDialog)
  overlay.querySelector('#settings-close')!.addEventListener('click', closeSettingsDialog)
}
