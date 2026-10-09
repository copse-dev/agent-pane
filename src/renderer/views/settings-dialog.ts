import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { ModelSettingsTarget } from '@shared/model-invalidation.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { qsRequired } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import { errorMessage } from '@shared/errors.ts'
import { createClassifiersSection } from './setup/classifiers-section.ts'
import { createSshWorkspaceSection } from './setup/ssh-workspace-section.ts'
import { createToolPermissionsPanel } from './tool-permissions-panel.ts'
import { createUsageSection } from './setup/usage-section.ts'
import { createAboutSection } from './setup/about-section.ts'
import { createModelsSection } from './settings/models-section.ts'
import { createProvidersSection } from './settings/providers-section.ts'
import { createAppearanceSection } from './settings/appearance-section.ts'
import { createSecuritySection } from './settings/security-section.ts'
import { createSourcesSection } from './settings/sources-section.ts'
import { createStorageSection } from './settings/storage-section.ts'
import { createMcpSection } from './settings/mcp-section.ts'
import { createPacksSection } from './settings/packs-section.ts'
import { SETTINGS_SECTIONS } from './settings/registry.ts'
import { createSettingsNavigation } from './settings/navigation-view.ts'
import { SettingsLifecycle } from './settings/lifecycle.ts'
import {
  loadSimpleFields,
  collectSimpleFields,
  renderSimpleFields,
  inputControl,
} from './settings/fields.ts'
import {
  bindSettingsDialog,
  setSettingsSubmitting,
  isSettingsDialogOpen,
  consumeSettingsOpenTarget,
  closeSettingsDialog,
  revealModelSettingsControl,
} from './settings/navigation.ts'
export {
  type SettingsSection,
  openSettingsDialog,
  openModelSettings,
  closeSettingsDialog,
  isSettingsDialogOpen,
  onSettingsDialogClose,
  openAutomationSettings,
} from './settings/navigation.ts'
export { applyUiAccent, applyUiTint } from './settings/appearance.ts'
export {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
  isUiTintStrength,
  type UiTintStrength,
} from '@shared/appearance.ts'

/** The shell owns navigation and Save/Cancel; feature controllers own their content. */
export function mountSettingsDialog(store: AppStore, api: ApiClient): void {
  const { dialog: overlay } = createOverlayDialog({
    id: 'settings-dialog',
    className: 'settings-overlay',
  })
  overlay.innerHTML = `
    <div class="settings-shell">
      <header class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-close-btn" id="settings-close" aria-label="Close settings" data-tooltip="Close settings"></button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <div class="settings-search">
            <input
              type="search"
              id="settings-search-input"
              class="settings-search-input"
              placeholder="Search settings…"
              aria-label="Search all settings"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          ${SETTINGS_SECTIONS.map((section) => `<button type="button" class="settings-nav-btn" data-section="${section.id}">${section.label}</button>`).join('')}

        </nav>

        <form class="settings-content" novalidate>
          ${SETTINGS_SECTIONS.map((section) => section.markup).join('')}

          <div class="settings-search-results" id="settings-search-results"></div>

          <p class="settings-search-empty" id="settings-search-empty" hidden></p>

          <div class="settings-buttons">
            <span id="settings-save-status" role="alert" hidden></span>
            <button type="submit" class="ui-btn ui-btn-primary">Save</button>
            <button type="button" id="settings-cancel" class="ui-btn ui-btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
  bindSettingsDialog(overlay)
  for (const definition of SETTINGS_SECTIONS) renderSimpleFields(overlay, definition.fields)
  qsRequired(overlay, '#settings-close').append(closeIcon('ui-icon'))

  // Every `qsRequired(overlay, …)` below targets an element baked into the static
  // template above; a miss throws a loud error (template/code drift) rather than a
  // silent non-null assertion.
  const classifiersSection = createClassifiersSection(api)
  qsRequired(overlay, '#settings-classifiers-host').append(classifiersSection.root)

  const sshWorkspaceSection = createSshWorkspaceSection(api, {
    deferOrdinaryWrites: true,
    // Dedicated host edits wake project-menu listeners immediately.
    onChanged: (): void => {
      store.emit('settings_changed')
    },
  })
  qsRequired(overlay, '#settings-ssh-workspace-host').append(sshWorkspaceSection.root)

  const providersSection = createProvidersSection(overlay, api)
  const toolPermissionsPanel = createToolPermissionsPanel(api.toolPermissions)
  qsRequired(overlay, '#tool-permissions-host').append(toolPermissionsPanel.root)

  const modelsSection = createModelsSection(overlay, api)
  const usageSection = createUsageSection(api, store, closeSettingsDialog)
  qsRequired(overlay, '#settings-usage-host').append(usageSection.root)

  const aboutSection = createAboutSection(api)
  qsRequired(overlay, '#settings-about-host').append(aboutSection.root)

  qsRequired<HTMLButtonElement>(overlay, '#mobile-companion-manage').addEventListener(
    'click',
    () => {
      closeSettingsDialog()
      void api.mobile.manage()
    },
  )

  const form = qsRequired<HTMLFormElement>(overlay, 'form')
  const status = qsRequired(overlay, '#settings-save-status')
  const saveButton = qsRequired<HTMLButtonElement>(form, 'button[type="submit"]')
  const closeButton = qsRequired<HTMLButtonElement>(overlay, '#settings-close')
  const body = qsRequired(overlay, '.settings-body')
  const dirty = new Set<string>()
  let snapshot: SettingsSnapshot | null = null
  let openGeneration = 0
  let submitting = false
  let modelTarget: ModelSettingsTarget | null = null
  const appearance = createAppearanceSection(form, store, (name) => dirty.add(name))
  const security = createSecuritySection(
    form,
    api,
    () => modelsSection.readSecurity(),
    () => providersSection.getUrl(),
  )
  const nav = createSettingsNavigation(overlay, (ids) => {
    if (snapshot) void lifecycle.show(ids, snapshot)
  })
  const packs = createPacksSection(
    overlay,
    api,
    store,
    () => nav.active(),
    async (id): Promise<AbortSignal | undefined> => {
      nav.reset(id)
      if (snapshot) await lifecycle.show([id], snapshot)
      return lifecycle.signalFor(id)
    },
    () => {
      if (nav.active() === 'mcp') void mcp.refreshDeclared()
    },
  )
  overlay.addEventListener('settings-section-shown', () => {
    packs.render()
  })
  const sources = createSourcesSection({
    root: overlay,
    api,
    onTrusted: (statuses): void => {
      mcp.render(statuses)
    },
    onHeadingsChanged: (): void => {
      nav.refreshHeadings()
    },
  })
  const mcp = createMcpSection(
    overlay,
    api,
    (statuses) => {
      mcp.render(statuses)
      void sources.refresh()
    },
    () => {
      nav.show('permissions')
      if (snapshot)
        void lifecycle.show(['permissions'], snapshot).then(() => {
          qsRequired(overlay, '#tool-permissions-fieldset').scrollIntoView({ block: 'start' })
        })
    },
    () => {
      nav.refreshHeadings()
    },
  )
  const storage = createStorageSection(overlay, api, store, closeSettingsDialog)
  const lifecycle = new SettingsLifecycle(
    {
      general: {
        retainDrafts: true,
        refresh: async (values, signal): Promise<void> => {
          await Promise.all([
            providersSection.refresh(values, signal),
            modelsSection.refresh(values, signal),
          ])
          if (!signal.aborted) nav.refreshHeadings()
        },
      },
      classifiers: {
        refresh: (_values, signal): Promise<void> => classifiersSection.refresh(signal),
      },
      usage: {
        refresh: async (_values, signal): Promise<void> => {
          await Promise.all([usageSection.refresh(signal), providersSection.refreshUsage(signal)])
        },
      },
      agent: { refresh: (_values, signal): Promise<void> => providersSection.refreshAgent(signal) },
      permissions: {
        refresh: (_values, signal): Promise<void> => toolPermissionsPanel.refresh(signal),
      },
      ssh: { refresh: (_values, signal): Promise<void> => sshWorkspaceSection.refresh(signal) },
      about: { refresh: (_values, signal): Promise<void> => aboutSection.refresh(signal) },
      customise: {
        refresh: async (_values, signal): Promise<void> => {
          await Promise.all([sources.refresh(), packs.refresh(signal)])
          if (!signal.aborted) await packs.reveal(signal)
        },
        deactivate: (): void => {
          sources.invalidate()
          packs.invalidate()
        },
      },
      experimental: {
        retainDrafts: true,
        refresh: async (values, signal): Promise<void> => {
          await Promise.all([modelsSection.refreshWorker(values, signal), packs.refresh(signal)])
        },
        deactivate: (): void => {
          packs.invalidate()
        },
      },
      storage: {
        refresh: (): Promise<void> => storage.refresh('', true),
        deactivate: (): void => {
          storage.invalidate()
        },
      },
      mcp: {
        refresh: async (): Promise<void> => {
          await Promise.all([mcp.refresh(), mcp.refreshCurated(), mcp.refreshDeclared()])
        },
        deactivate: (): void => {
          mcp.invalidate()
        },
      },
    },
    (id, error): void => {
      status.textContent = `Could not load ${id}: ${errorMessage(error)}`
      status.hidden = false
      overlay.dataset['settingsRefreshFailed'] = id
    },
  )

  function syncDeveloperOnlySettings(): void {
    qsRequired(overlay, '[data-developer-only="hooks"]').hidden =
      !inputControl(form, 'developerMode').checked &&
      !inputControl(form, 'cursorHooksEnabled').checked
    nav.refreshHeadings()
  }
  for (const type of ['input', 'change'])
    form.addEventListener(type, (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        if (target.name) dirty.add(target.name)
      }
      providersSection.markDirty(target)
      if (target instanceof HTMLSelectElement && target.name === 'model') {
        modelsSection.setModel(target.value)
        packs.updateAdvisorPairHint()
      }
      syncDeveloperOnlySettings()
    })

  function setLoading(loading: boolean): void {
    for (const section of overlay.querySelectorAll<HTMLElement>('.settings-section'))
      section.inert = loading
    saveButton.disabled = loading
    form.setAttribute('aria-busy', String(loading))
  }

  overlay.addEventListener('settings-open', () => {
    const mine = ++openGeneration
    lifecycle.reset()
    dirty.clear()
    snapshot = null
    providersSection.reset()
    storage.reset()
    appearance.begin()
    status.hidden = true
    delete overlay.dataset['settingsRefreshFailed']
    setLoading(true)
    const target = consumeSettingsOpenTarget()
    modelTarget = target.modelTarget
    nav.reset(target.section)
    packs.setDetail(target.pluginDetail)
    void (async (): Promise<void> => {
      const values = await api.settings.getSnapshot()
      if (mine !== openGeneration || !isSettingsDialogOpen()) return
      snapshot = values
      for (const section of SETTINGS_SECTIONS) loadSimpleFields(overlay, section.fields, values)
      providersSection.load(values)
      modelsSection.load(values)
      appearance.load(values)
      security.load(values)
      sshWorkspaceSection.load(values)
      syncDeveloperOnlySettings()
      setLoading(false)
      await lifecycle.show([nav.active()], values)
      if (mine === openGeneration && isSettingsDialogOpen() && modelTarget)
        revealModelSettingsControl(overlay, modelTarget)
    })().catch((error: unknown) => {
      if (mine !== openGeneration || !isSettingsDialogOpen()) return
      status.textContent = `Could not load settings: ${errorMessage(error)}`
      status.hidden = false
    })
  })
  overlay.addEventListener('settings-reveal-model', () => {
    const target = consumeSettingsOpenTarget()
    modelTarget = target.modelTarget
    nav.reset(target.section)
    if (!snapshot) return
    const mine = openGeneration
    void lifecycle.show([target.section], snapshot).then(() => {
      if (
        mine === openGeneration &&
        overlay.open &&
        modelTarget === target.modelTarget &&
        modelTarget
      )
        revealModelSettingsControl(overlay, modelTarget)
    })
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submitting || !snapshot) return
    const invalid = [...form.elements].find(
      (control) =>
        (control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) &&
        dirty.has(control.name) &&
        !control.checkValidity(),
    )
    if (invalid instanceof HTMLElement) {
      nav.reveal(invalid)
      if (
        invalid instanceof HTMLInputElement ||
        invalid instanceof HTMLSelectElement ||
        invalid instanceof HTMLTextAreaElement
      )
        invalid.reportValidity()
      return
    }
    submitting = true
    setSettingsSubmitting(true)
    body.inert = true
    closeButton.disabled = true
    const savedDirty = new Set(dirty)
    saveButton.disabled = true
    saveButton.textContent = 'Saving…'
    status.hidden = true
    const mine = openGeneration
    void (async (): Promise<void> => {
      const data = new FormData(form)
      const changes: SettingsUpdate = {
        ...modelsSection.collect(data, savedDirty),
        ...providersSection.collect(data, savedDirty),
        ...appearance.collect(data, savedDirty),
        ...sshWorkspaceSection.collect(data, savedDirty),
      }
      for (const section of SETTINGS_SECTIONS)
        Object.assign(changes, collectSimpleFields(section.fields, data, savedDirty))
      // Validate and commit the complete ordinary update in one host transaction.
      await api.settings.update(changes)
      appearance.commit(changes)
      const state = store.getState()
      store.setState({
        openLinksInBuiltInBrowser:
          changes.openLinksInBuiltInBrowser ?? state.openLinksInBuiltInBrowser,
        animateAgentAvatars: changes.animateAgentAvatars ?? state.animateAgentAvatars,
        conciseThreadsEnabled: changes.conciseThreadsEnabled ?? state.conciseThreadsEnabled,
        developerMode: changes.developerMode ?? state.developerMode,
        ...(changes.model === undefined
          ? {}
          : { settings: { ...state.settings, model: changes.model } }),
      })
      store.emit('settings_changed')
      window.dispatchEvent(new Event('copse:skills-changed'))
      await security.save(data, savedDirty)
      if (!(await providersSection.saveKeys())) {
        if (mine === openGeneration && isSettingsDialogOpen()) {
          nav.show('general')
          status.textContent =
            'Preferences saved. Review the credential fields before saving again.'
          status.hidden = false
        }
        return
      }
      if (changes.appIconVariant) await api.appIcon.apply()
      if (mine === openGeneration && isSettingsDialogOpen()) {
        setSettingsSubmitting(false)
        closeSettingsDialog()
      }
    })()
      .catch((error: unknown) => {
        if (mine !== openGeneration || !isSettingsDialogOpen()) return
        status.textContent = errorMessage(error)
        status.hidden = false
      })
      .finally(() => {
        submitting = false
        setSettingsSubmitting(false)
        body.inert = false
        closeButton.disabled = false
        saveButton.disabled = !snapshot
        saveButton.textContent = 'Save'
      })
  })
  overlay.addEventListener('cancel', (event) => {
    if (submitting) event.preventDefault()
  })
  overlay.addEventListener('close', () => {
    openGeneration += 1
    lifecycle.cancel()
    snapshot = null
    appearance.rollback()
    providersSection.reset()
    dirty.clear()
  })
  qsRequired(overlay, '#settings-cancel').addEventListener('click', closeSettingsDialog)
  qsRequired(overlay, '#settings-close').addEventListener('click', closeSettingsDialog)
}
