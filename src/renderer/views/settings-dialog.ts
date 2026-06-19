import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { populateModelSelect } from './model-options.ts'

export function mountSettingsDialog(store: AppStore, api: ApiClient): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'settings-dialog'
  dialog.className = 'settings-dialog'
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Settings</h2>

      <fieldset>
        <legend>API Keys</legend>
        <label>
          Anthropic API key
          <input type="password" name="anthropicKey" placeholder="sk-ant-…" autocomplete="off" />
          <span class="key-status" data-key="anthropic"></span>
        </label>
        <label>
          OpenAI API key
          <input type="password" name="openaiKey" placeholder="sk-…" autocomplete="off" />
          <span class="key-status" data-key="openai"></span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Model</legend>
        <label>
          Model
          <select name="model"></select>
        </label>
      </fieldset>

      <fieldset>
        <legend>LM Studio (local server)</legend>
        <label>
          Server URL
          <input type="text" name="lmStudioUrl" placeholder="http://localhost:1234/v1" autocomplete="off" />
        </label>
        <label>
          Model name (blank = first loaded)
          <input type="text" name="lmStudioModel" placeholder="(auto)" autocomplete="off" />
        </label>
        <label>
          API key (only if your LM Studio server requires one)
          <input type="password" name="lmStudioKey" placeholder="leave blank if disabled" autocomplete="off" />
          <span class="key-status" data-key="lmstudio"></span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="lmStudioForSmallTasks" />
          Use LM Studio for small tasks (e.g. naming threads)
        </label>
        <div class="lmstudio-test-row">
          <button type="button" id="lmstudio-test-btn">Test connection</button>
          <span class="lmstudio-test-status" id="lmstudio-test-status"></span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Appearance</legend>
        <label>
          Theme
          <select name="theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          Font size
          <input type="number" name="fontSize" min="12" max="20" step="1" />
        </label>
      </fieldset>

      <div class="settings-buttons">
        <button type="submit">Save</button>
        <button type="button" id="settings-cancel">Cancel</button>
      </div>
    </form>
  `
  document.body.append(dialog)

  // Populate key status badges on open
  dialog.addEventListener('toggle', () => {
    if (!(dialog as HTMLDialogElement).open) return
    void (async () => {
      const anthSet = await api.settings.getKey('anthropic')
      const openSet = await api.settings.getKey('openai')
      const lmSet = await api.settings.getKey('lmstudio')
      dialog.querySelector('[data-key="anthropic"]')!.textContent = anthSet ? '● set' : '○ not set'
      dialog.querySelector('[data-key="openai"]')!.textContent = openSet ? '● set' : '○ not set'
      dialog.querySelector('[data-key="lmstudio"]')!.textContent = lmSet ? '● set' : '○ not set'

      const form = dialog.querySelector('form') as HTMLFormElement
      const model = (await api.settings.get('model')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('model') as HTMLSelectElement,
        api,
        model ?? 'claude-sonnet-4-6',
      )
      ;(form.elements.namedItem('theme') as HTMLSelectElement).value = store.getState().theme
      ;(form.elements.namedItem('fontSize') as HTMLInputElement).value = String(
        store.getState().fontSize,
      )

      const lmUrl = (await api.settings.get('lmStudioUrl')) as string | undefined
      const lmModel = (await api.settings.get('lmStudioModel')) as string | undefined
      const lmSmall = (await api.settings.get('lmStudioForSmallTasks')) as boolean | undefined
      ;(form.elements.namedItem('lmStudioUrl') as HTMLInputElement).value =
        lmUrl ?? 'http://localhost:1234/v1'
      ;(form.elements.namedItem('lmStudioModel') as HTMLInputElement).value = lmModel ?? ''
      ;(form.elements.namedItem('lmStudioForSmallTasks') as HTMLInputElement).checked =
        lmSmall ?? true
    })()
  })

  dialog.querySelector('form')!.addEventListener('submit', () => {
    void (async () => {
      const form = dialog.querySelector('form') as HTMLFormElement
      const data = new FormData(form)

      const anthKey = (data.get('anthropicKey') as string).trim()
      const openKey = (data.get('openaiKey') as string).trim()
      const lmKey = (data.get('lmStudioKey') as string).trim()
      if (anthKey) await api.settings.setKey('anthropic', anthKey)
      if (openKey) await api.settings.setKey('openai', openKey)
      if (lmKey) await api.settings.setKey('lmstudio', lmKey)

      const model = data.get('model') as string
      const theme = data.get('theme') as 'light' | 'dark'
      const fontSize = parseInt(data.get('fontSize') as string, 10)

      await api.settings.set('model', model)
      await api.settings.set('theme', theme)
      await api.settings.set('fontSize', fontSize)
      await api.settings.set('lmStudioUrl', (data.get('lmStudioUrl') as string).trim())
      await api.settings.set('lmStudioModel', (data.get('lmStudioModel') as string).trim())
      await api.settings.set('lmStudioForSmallTasks', data.get('lmStudioForSmallTasks') === 'on')

      store.setState({ theme, fontSize, settings: { ...store.getState().settings, model } })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      document.documentElement.dataset.theme = theme
    })()
  })

  // Local-only connectivity check for LM Studio — never runs against billed APIs.
  dialog.querySelector('#lmstudio-test-btn')!.addEventListener('click', () => {
    const form = dialog.querySelector('form') as HTMLFormElement
    const url = (form.elements.namedItem('lmStudioUrl') as HTMLInputElement).value.trim()
    const key = (form.elements.namedItem('lmStudioKey') as HTMLInputElement).value.trim()
    const statusEl = dialog.querySelector('#lmstudio-test-status') as HTMLElement
    statusEl.textContent = 'Testing…'
    statusEl.className = 'lmstudio-test-status'
    void api.lmStudio.test(url, key).then((r) => {
      if (r.ok) {
        const list = r.models && r.models.length ? r.models.slice(0, 3).join(', ') : 'no models loaded'
        statusEl.textContent = `✓ Connected — ${r.models?.length ?? 0} model(s): ${list}`
        statusEl.classList.add('ok')
      } else {
        statusEl.textContent = `✗ ${r.error ?? 'Connection failed'}`
        statusEl.classList.add('err')
      }
    })
  })

  dialog.querySelector('#settings-cancel')!.addEventListener('click', () => {
    dialog.close()
  })
}
