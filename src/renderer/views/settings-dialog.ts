import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
  type AppIconVariant,
} from '@shared/app-icon-variants.ts'
import { populateModelSelect } from './model-options.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createModelRoutingSection } from './setup/model-routing-section.ts'

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

            <div id="settings-api-keys-host"></div>

            <fieldset>
              <legend>Chat model</legend>
              <label>
                Default model
                <select name="model"></select>
              </label>
            </fieldset>

            <fieldset>
              <legend>Agent behavior</legend>
              <label>
                Custom instructions
                <textarea
                  name="customInstructions"
                  rows="4"
                  placeholder="Always-on guidance added to every conversation (e.g. preferred style, conventions)."
                ></textarea>
                <span class="field-hint">
                  Appended to the system prompt for every thread. A project <code>AGENT.md</code> adds
                  per-project instructions on top of this.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="externalApiSafety" />
                External-API safety steering
              </label>
              <p class="field-hint">
                Reminds the agent to pick compatible dependency versions and never hardcode or log
                secrets when adding API calls.
              </p>
            </fieldset>
          </section>

          <section class="settings-section" data-section="local-models">
            <h3>Local models</h3>
            <p class="settings-section-desc">
              Connect to an LM Studio (or other OpenAI-compatible) server and route different tasks to
              specific local models.
            </p>

            <div id="settings-lm-studio-host"></div>

            <div id="settings-model-routing-host"></div>

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
                <input type="checkbox" name="lmStudioForTodoItems" />
                Use local models for todo items tagged local (requires acceptance check)
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

  const apiKeysSection = createApiKeysSection(api)
  overlay.querySelector('#settings-api-keys-host')!.append(apiKeysSection.root)

  const lmStudioSection = createLmStudioSection(api, { showInstallGuide: false })
  overlay.querySelector('#settings-lm-studio-host')!.append(lmStudioSection.root)

  const modelRoutingSection = createModelRoutingSection(api)
  overlay.querySelector('#settings-model-routing-host')!.append(modelRoutingSection.root)

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
    await modelRoutingSection.refresh()
  }

  function renderMcpServers(statuses: import('@shared/types/mcp.ts').McpServerStatus[]): void {
    const listEl = overlay.querySelector('#mcp-server-list') as HTMLElement
    if (statuses.length === 0) {
      listEl.textContent = 'No servers configured.'
      return
    }
    listEl.innerHTML = ''

    // Project-defined servers in an untrusted workspace are not spawned (#100).
    // Offer an explicit "trust this workspace" action before any are started.
    if (statuses.some((s) => s.state === 'untrusted')) {
      const banner = document.createElement('div')
      banner.className = 'mcp-trust-banner'
      const text = document.createElement('span')
      text.textContent =
        'This workspace defines its own MCP servers. They will not run until you trust this workspace.'
      const trustBtn = document.createElement('button')
      trustBtn.type = 'button'
      trustBtn.textContent = 'Trust this workspace'
      trustBtn.addEventListener('click', () => {
        trustBtn.disabled = true
        void api.workspace
          .setTrusted(true)
          .then((next) => renderMcpServers(next))
          .catch(() => {
            trustBtn.disabled = false
          })
      })
      banner.append(text, trustBtn)
      listEl.append(banner)
    }

    for (const s of statuses) {
      const badge =
        s.state === 'connected'
          ? '● connected'
          : s.state === 'error'
            ? '✗ error'
            : s.state === 'disabled'
              ? '○ disabled'
              : s.state === 'untrusted'
                ? '⚠ not trusted'
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
      toggle.checked = s.userEnabled && !s.configDisabled && s.state !== 'untrusted'
      toggle.disabled = s.configDisabled || s.state === 'untrusted'
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
            if (!s.configDisabled && s.state !== 'untrusted') toggle.disabled = false
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
      await apiKeysSection.refreshKeyStatus()

      const form = overlay.querySelector('form') as HTMLFormElement
      const model = (await api.settings.get('model')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('model') as HTMLSelectElement,
        api,
        model ?? 'claude-sonnet-4-6',
      )
      const customInstructions = (await api.settings.get('customInstructions')) as
        | string
        | undefined
      ;(form.elements.namedItem('customInstructions') as HTMLTextAreaElement).value =
        customInstructions ?? ''
      const externalApiSafety = (await api.settings.get('externalApiSafety')) as boolean | undefined
      ;(form.elements.namedItem('externalApiSafety') as HTMLInputElement).checked =
        externalApiSafety ?? false
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

      const lmSmallEnabled = (await api.settings.get('lmStudioForSmallTasks')) as
        | boolean
        | undefined
      const lmSubagentsEnabled = (await api.settings.get('lmStudioForSubagents')) as
        | boolean
        | undefined
      const lmTodoItemsEnabled = (await api.settings.get('lmStudioForTodoItems')) as
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
      ;(form.elements.namedItem('lmStudioForSmallTasks') as HTMLInputElement).checked =
        lmSmallEnabled ?? true
      ;(form.elements.namedItem('lmStudioForSubagents') as HTMLInputElement).checked =
        lmSubagentsEnabled ?? true
      ;(form.elements.namedItem('lmStudioForTodoItems') as HTMLInputElement).checked =
        lmTodoItemsEnabled ?? true
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
      await lmStudioSection.refreshDetection()
      await refreshMcpServers()
    })()
  })

  overlay.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const form = overlay.querySelector('form') as HTMLFormElement
      const data = new FormData(form)

      await apiKeysSection.saveKeys()
      await lmStudioSection.saveConnection()
      const routingValues = modelRoutingSection.readValues()

      const model = data.get('model') as string
      const theme = data.get('theme') as 'light' | 'dark'
      const fontSize = parseInt(data.get('fontSize') as string, 10)
      const appIconVariant = data.get('appIconVariant') as AppIconVariant
      const confidence = parseFloat(data.get('lmStudioSafetyConfidenceThreshold') as string)

      await api.settings.set('model', model)
      await api.settings.set(
        'customInstructions',
        (data.get('customInstructions') as string).trim(),
      )
      await api.settings.set('externalApiSafety', data.get('externalApiSafety') === 'on')
      await api.settings.set('theme', theme)
      await api.settings.set('fontSize', fontSize)
      if (isAppIconVariant(appIconVariant)) {
        await api.settings.set('appIconVariant', appIconVariant)
        await api.appIcon.apply()
      }
      await api.settings.set('lmStudioModel', routingValues.lmStudioModel)
      await api.settings.set('lmStudioSmallTasksModel', routingValues.lmStudioSmallTasksModel)
      await api.settings.set('lmStudioSubagentModel', routingValues.lmStudioSubagentModel)
      await api.settings.setSecurity({
        lmStudioUrl: lmStudioSection.getUrl(),
        lmStudioSafetyModel: routingValues.lmStudioSafetyModel,
        lmStudioSafetyEnabled: data.get('lmStudioSafetyEnabled') === 'on',
        lmStudioSafetyConfidenceThreshold: Number.isFinite(confidence) ? confidence : 0.85,
        autoRunSandboxCommands: data.get('autoRunSandboxCommands') === 'on',
        mcpAutoAllowReadOnly: data.get('mcpAutoAllowReadOnly') === 'on',
      })
      await api.settings.set('lmStudioForSmallTasks', data.get('lmStudioForSmallTasks') === 'on')
      await api.settings.set('lmStudioForSubagents', data.get('lmStudioForSubagents') === 'on')
      await api.settings.set('lmStudioForTodoItems', data.get('lmStudioForTodoItems') === 'on')

      store.setState({ theme, fontSize, settings: { ...store.getState().settings, model } })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      document.documentElement.dataset.theme = theme
      closeSettingsDialog()
    })()
  })

  overlay.querySelector('#settings-cancel')!.addEventListener('click', closeSettingsDialog)
  overlay.querySelector('#settings-close')!.addEventListener('click', closeSettingsDialog)
}
