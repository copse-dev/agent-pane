import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
  type AppIconVariant,
} from '@shared/app-icon-variants.ts'
import { populateLocalModelSelect, populateModelSelect } from './model-options.ts'

type SettingsSection = 'general' | 'local-models' | 'mcp' | 'appearance'

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
  overlay.innerHTML = `
    <div class="settings-shell">
      <header class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-close-btn" id="settings-close" aria-label="Close settings">✕</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <button type="button" class="settings-nav-btn active" data-section="general">General</button>
          <button type="button" class="settings-nav-btn" data-section="local-models">Local models</button>
          <button type="button" class="settings-nav-btn" data-section="mcp">MCP servers</button>
          <button type="button" class="settings-nav-btn" data-section="appearance">Appearance</button>
        </nav>

        <form class="settings-content">
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">Cloud API keys and the default chat model for new conversations.</p>

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
              <legend>Chat model</legend>
              <label>
                Default model
                <select name="model"></select>
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="local-models">
            <h3>Local models</h3>
            <p class="settings-section-desc">
              Connect to an LM Studio (or other OpenAI-compatible) server and route different tasks to
              specific local models.
            </p>

            <fieldset>
              <legend>Server connection</legend>
              <label>
                Server URL
                <input type="text" name="lmStudioUrl" placeholder="http://localhost:1234/v1" autocomplete="off" />
              </label>
              <label>
                API key (only if your server requires one)
                <input type="password" name="lmStudioKey" placeholder="leave blank if disabled" autocomplete="off" />
                <span class="key-status" data-key="lmstudio"></span>
              </label>
              <div class="lmstudio-test-row">
                <button type="button" id="lmstudio-test-btn">Test connection</button>
                <span class="lmstudio-test-status" id="lmstudio-test-status"></span>
              </div>
              <p class="field-hint">
                Agent history trimming uses each loaded model’s context length when LM Studio reports it
                via the models API; otherwise 8192 tokens.
              </p>
            </fieldset>

            <fieldset>
              <legend>Model routing</legend>
              <p class="settings-fieldset-desc">
                Choose which loaded model handles each task. Leave a route on “auto” to use the first model
                the server reports.
              </p>
              <label>
                Default local model
                <select name="lmStudioModel"></select>
                <span class="field-hint">Fallback when a local model is selected in chat but not specified</span>
              </label>
              <label>
                Small tasks model
                <select name="lmStudioSmallTasksModel"></select>
                <span class="field-hint">Thread title generation and other lightweight prompts</span>
              </label>
              <label>
                Exploration subagent model
                <select name="lmStudioSubagentModel"></select>
                <span class="field-hint">File exploration when the chat model is a cloud API model</span>
              </label>
              <label>
                Instruct / safety model
                <select name="lmStudioSafetyModel"></select>
                <span class="field-hint">Classifies shell commands when the OS sandbox is off</span>
              </label>
            </fieldset>

            <fieldset>
              <legend>Routing behavior</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="lmStudioForSmallTasks" />
                Use local models for small tasks (e.g. naming threads)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="lmStudioForSubagents" />
                Use local models for exploration subagents when chat uses a cloud model
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="lmStudioSafetyEnabled" />
                Use instruct model to classify shell commands (when OS sandbox is off)
              </label>
              <label>
                Safety confidence threshold
                <input
                  type="number"
                  name="lmStudioSafetyConfidenceThreshold"
                  min="0"
                  max="1"
                  step="0.05"
                />
                <span class="field-hint">Auto-allow sandbox-scoped commands at or above this confidence (0–1)</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Auto-run shell commands contained within the sandbox
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="mcp">
            <h3>MCP servers</h3>
            <p class="settings-section-desc">
              Model Context Protocol servers expose external tools to the agent. Define them in
              <code>.cursor/mcp.json</code> (project), <code>.mcp.json</code> (project), or
              <code>~/.cursor/mcp.json</code> (global) using the standard <code>mcpServers</code> format,
              then reload.
            </p>

            <fieldset>
              <legend>Connected servers</legend>
              <div id="mcp-server-list" class="mcp-server-list">No servers loaded.</div>
              <p class="field-hint">
                Use the switch on each server to turn it off without editing your MCP config files.
                Off servers are not started on reload.
              </p>
              <div class="lmstudio-test-row">
                <button type="button" id="mcp-reload-btn">Reload servers</button>
                <span class="lmstudio-test-status" id="mcp-reload-status"></span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Tool approval</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="mcpAutoAllowReadOnly" />
                Auto-run MCP tools the server flags as read-only
              </label>
              <p class="field-hint">
                Destructive tools always prompt. Other tools prompt once; choose “always allow” to
                remember a specific tool.
              </p>
            </fieldset>
          </section>

          <section class="settings-section" data-section="appearance">
            <h3>Appearance</h3>
            <p class="settings-section-desc">Theme, app icon, and editor font size.</p>

            <fieldset>
              <legend>Display</legend>
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

            <fieldset>
              <legend>App icon</legend>
              <p class="settings-fieldset-desc">
                Choose the icon shown in the Dock, taskbar, and window title bar.
              </p>
              <div class="app-icon-picker" role="radiogroup" aria-label="App icon">
                ${APP_ICON_VARIANTS.map(
                  (variant) => `
                <label class="app-icon-option">
                  <input type="radio" name="appIconVariant" value="${variant}" />
                  <span class="app-icon-preview">
                    <img src="./icon-previews/${variant}.png" alt="" width="64" height="64" />
                  </span>
                  <span class="app-icon-label">${APP_ICON_VARIANT_LABELS[variant]}</span>
                </label>`,
                ).join('')}
              </div>
            </fieldset>
          </section>

          <div class="settings-buttons">
            <button type="submit">Save</button>
            <button type="button" id="settings-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
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
    const lmSubagent = (await api.settings.get('lmStudioSubagentModel')) as string | undefined
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
      form.elements.namedItem('lmStudioSubagentModel') as HTMLSelectElement,
      models,
      lmSubagent ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      form.elements.namedItem('lmStudioSafetyModel') as HTMLSelectElement,
      models,
      lmSafety ?? '',
      '(auto — use default local model)',
    )
  }

  function renderMcpServers(statuses: import('@shared/types/mcp.ts').McpServerStatus[]): void {
    const listEl = overlay.querySelector('#mcp-server-list') as HTMLElement
    if (statuses.length === 0) {
      listEl.textContent = 'No servers configured.'
      return
    }
    listEl.innerHTML = ''
    for (const s of statuses) {
      const badge =
        s.state === 'connected'
          ? '● connected'
          : s.state === 'error'
            ? '✗ error'
            : s.state === 'disabled'
              ? '○ disabled'
              : '… connecting'
      const row = document.createElement('div')
      row.className = `mcp-server-row mcp-state-${s.state}`

      const header = document.createElement('div')
      header.className = 'mcp-server-header'

      const toggleLabel = document.createElement('label')
      toggleLabel.className = 'toggle-switch mcp-server-toggle'
      toggleLabel.title = s.configDisabled
        ? 'This server is disabled in your MCP config file'
        : s.userEnabled
          ? 'Turn off this MCP server'
          : 'Turn on this MCP server'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = s.userEnabled && !s.configDisabled
      toggle.disabled = s.configDisabled
      toggle.setAttribute('aria-label', `${s.name} MCP server enabled`)
      const track = document.createElement('span')
      track.className = 'toggle-switch-track'
      track.setAttribute('aria-hidden', 'true')
      toggle.addEventListener('change', () => {
        toggle.disabled = true
        void api.mcp
          .setEnabled(s.name, toggle.checked)
          .then((next) => {
            renderMcpServers(next)
          })
          .catch(() => {
            toggle.checked = !toggle.checked
          })
          .finally(() => {
            if (!s.configDisabled) toggle.disabled = false
          })
      })
      toggleLabel.append(toggle, track)

      const title = document.createElement('div')
      title.className = 'mcp-server-summary'
      title.textContent = `${s.name} (${s.transport}) — ${badge}`

      header.append(toggleLabel, title)
      row.append(header)

      let detailText =
        s.state === 'connected'
          ? `${s.toolCount} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`
          : (s.error ?? '')
      if (s.configDisabled) {
        detailText = detailText
          ? `${detailText} · disabled in MCP config`
          : 'Disabled in MCP config ("disabled": true)'
      } else if (!s.userEnabled && s.state === 'disabled') {
        detailText = 'Turned off in Settings'
      }
      if (detailText) {
        row.append(
          Object.assign(document.createElement('div'), {
            className: 'mcp-server-detail',
            textContent: detailText,
          }),
        )
      }
      listEl.append(row)
    }
  }

  async function refreshMcpServers(): Promise<void> {
    try {
      renderMcpServers(await api.mcp.list())
    } catch {
      renderMcpServers([])
    }
  }

  overlay.querySelector('#mcp-reload-btn')!.addEventListener('click', () => {
    const statusEl = overlay.querySelector('#mcp-reload-status') as HTMLElement
    statusEl.textContent = 'Reloading…'
    statusEl.className = 'lmstudio-test-status'
    void api.mcp
      .reload()
      .then((statuses) => {
        renderMcpServers(statuses)
        const ok = statuses.filter((s) => s.state === 'connected').length
        statusEl.textContent = `✓ ${ok}/${statuses.length} server(s) connected`
        statusEl.classList.add('ok')
      })
      .catch((err) => {
        statusEl.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`
        statusEl.classList.add('err')
      })
  })

  overlay.addEventListener('settings-open', () => {
    showSection('general')
    void (async () => {
      const anthSet = await api.settings.getKey('anthropic')
      const openSet = await api.settings.getKey('openai')
      const lmSet = await api.settings.getKey('lmstudio')
      overlay.querySelector('[data-key="anthropic"]')!.textContent = anthSet ? '● set' : '○ not set'
      overlay.querySelector('[data-key="openai"]')!.textContent = openSet ? '● set' : '○ not set'
      overlay.querySelector('[data-key="lmstudio"]')!.textContent = lmSet ? '● set' : '○ not set'

      const form = overlay.querySelector('form') as HTMLFormElement
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

      const savedIconVariant = (await api.settings.get('appIconVariant')) as unknown
      const appIconVariant = isAppIconVariant(savedIconVariant)
        ? savedIconVariant
        : DEFAULT_APP_ICON_VARIANT
      const iconRadio = form.querySelector<HTMLInputElement>(
        `input[name="appIconVariant"][value="${appIconVariant}"]`,
      )
      if (iconRadio) iconRadio.checked = true

      const lmUrl = (await api.settings.get('lmStudioUrl')) as string | undefined
      const lmSmallEnabled = (await api.settings.get('lmStudioForSmallTasks')) as
        | boolean
        | undefined
      const lmSubagentsEnabled = (await api.settings.get('lmStudioForSubagents')) as
        | boolean
        | undefined
      const lmSafetyEnabled = (await api.settings.get('lmStudioSafetyEnabled')) as
        | boolean
        | undefined
      const autoRunSandbox = (await api.settings.get('autoRunSandboxCommands')) as
        | boolean
        | undefined
      const confidence = (await api.settings.get('lmStudioSafetyConfidenceThreshold')) as
        | number
        | undefined
      ;(form.elements.namedItem('lmStudioUrl') as HTMLInputElement).value =
        lmUrl ?? 'http://localhost:1234/v1'
      ;(form.elements.namedItem('lmStudioForSmallTasks') as HTMLInputElement).checked =
        lmSmallEnabled ?? true
      ;(form.elements.namedItem('lmStudioForSubagents') as HTMLInputElement).checked =
        lmSubagentsEnabled ?? true
      ;(form.elements.namedItem('lmStudioSafetyEnabled') as HTMLInputElement).checked =
        lmSafetyEnabled ?? true
      ;(form.elements.namedItem('autoRunSandboxCommands') as HTMLInputElement).checked =
        autoRunSandbox ?? true
      ;(form.elements.namedItem('lmStudioSafetyConfidenceThreshold') as HTMLInputElement).value =
        String(confidence ?? 0.85)

      const mcpAutoAllow = (await api.settings.get('mcpAutoAllowReadOnly')) as boolean | undefined
      ;(form.elements.namedItem('mcpAutoAllowReadOnly') as HTMLInputElement).checked =
        mcpAutoAllow ?? false

      await refreshLocalModelSelects()
      await refreshMcpServers()
    })()
  })

  overlay.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const form = overlay.querySelector('form') as HTMLFormElement
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
      const appIconVariant = data.get('appIconVariant') as AppIconVariant
      const confidence = parseFloat(data.get('lmStudioSafetyConfidenceThreshold') as string)

      await api.settings.set('model', model)
      await api.settings.set('theme', theme)
      await api.settings.set('fontSize', fontSize)
      if (isAppIconVariant(appIconVariant)) {
        await api.settings.set('appIconVariant', appIconVariant)
        await api.appIcon.apply()
      }
      await api.settings.set('lmStudioUrl', (data.get('lmStudioUrl') as string).trim())
      await api.settings.set('lmStudioModel', (data.get('lmStudioModel') as string).trim())
      await api.settings.set(
        'lmStudioSmallTasksModel',
        (data.get('lmStudioSmallTasksModel') as string).trim(),
      )
      await api.settings.set(
        'lmStudioSubagentModel',
        (data.get('lmStudioSubagentModel') as string).trim(),
      )
      await api.settings.set('lmStudioForSmallTasks', data.get('lmStudioForSmallTasks') === 'on')
      await api.settings.set('lmStudioForSubagents', data.get('lmStudioForSubagents') === 'on')
      await api.settings.set(
        'lmStudioSafetyModel',
        (data.get('lmStudioSafetyModel') as string).trim(),
      )
      await api.settings.set('lmStudioSafetyEnabled', data.get('lmStudioSafetyEnabled') === 'on')
      await api.settings.set(
        'lmStudioSafetyConfidenceThreshold',
        Number.isFinite(confidence) ? confidence : 0.85,
      )
      await api.settings.set('autoRunSandboxCommands', data.get('autoRunSandboxCommands') === 'on')
      await api.settings.set('mcpAutoAllowReadOnly', data.get('mcpAutoAllowReadOnly') === 'on')

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
