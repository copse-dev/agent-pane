import { createPluginCatalogBrowser } from '../plugin-catalog-browser.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import type { PluginInstallRecord, PluginInstallReview } from '@shared/types/plugin-installs.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { humanizeIdentifier } from '@shared/humanize-identifier.ts'
import { errorMessage } from '@shared/errors.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { chevronDownIcon } from '../../dom/icons.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import {
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '@copse/agent/canvas-settings.ts'
import { PARALLEL_SEARCH_PLUGIN_ID } from '@copse/agent/plugins/parallel-search-plugin.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { createAutomationPluginSettings } from '../automation-plugin-settings.ts'
import { createParallelSearchPluginSettings } from '../parallel-search-plugin-settings.ts'
import { createAppleDevelopmentPanel } from '../apple-development-panel.ts'
import { mountModelSelectPicker } from '../model-picker.ts'
import { fetchDynamicModelOptions, modelDisplayLabel } from '../model-options.ts'
import { validateAdvisorPair } from '@shared/advisor-pair.ts'
import type { SettingsSection, PluginDetailTarget } from './navigation.ts'

export function pluginDisplayName(
  plugin: import('@shared/types/plugins.ts').PluginSummary,
): string {
  const raw = plugin.name || plugin.id
  if (plugin.trust !== 'first-party') return raw
  if (plugin.id === 'copse.mcp-ui-canvas') return 'Canvas and explainers'
  const stripped = raw.startsWith('copse.') ? raw.slice('copse.'.length) : raw
  return stripped ? humanizeIdentifier(stripped).replaceAll('-', ' ') : raw
}

function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** `skills/figma-use/SKILL.md` → `figma-use`; a root `SKILL.md` is the plugin's own. */
function installReviewSkillName(path: string, pluginId: string): string {
  const parts = path.split('/')
  if (parts.at(-1) !== 'SKILL.md') return path
  return parts.at(-2) ?? pluginId
}

function installReviewSection(heading: string, body: HTMLElement): HTMLElement {
  const section = document.createElement('section')
  section.className = 'plugin-install-review-section'
  const title = document.createElement('div')
  title.className = 'plugin-install-review-heading'
  title.textContent = heading
  section.append(title, body)
  return section
}

export interface PacksSection {
  refresh(signal?: AbortSignal): Promise<void>
  render(): void
  reveal(signal?: AbortSignal): Promise<void>
  updateAdvisorPairHint(): void
  setDetail(target: PluginDetailTarget | null): void
  invalidate(): void
}
export function createPacksSection(
  overlay: HTMLElement,
  api: ApiClient,
  store: AppStore,
  getActiveSection: () => SettingsSection,
  onNavigate: (section: SettingsSection) => Promise<AbortSignal | undefined>,
  onMcpChanged: () => void,
): PacksSection {
  function selectControl(form: HTMLFormElement, name: string): HTMLSelectElement {
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLSelectElement)) throw new Error(`Missing select ${name}`)
    return control
  }
  // The advisor model now lives with the `copse.advisor-strategy` plugin (Settings
  // → Plugins), so its select + pairing-hint elements are created by
  // `refreshPlugins()` (in `makePluginRow`) and handed to `updateAdvisorPairHint`
  // via these refs — both null until the plugins list has rendered; the executor
  // is still the global chat-model select in the General section.
  let advisorModelSelectEl: HTMLSelectElement | null = null
  let advisorPairHintEl: HTMLElement | null = null
  // A plugin `model` field loads the live catalogue asynchronously through the
  // shared searchable picker. Its refresh promise is stashed so the advisor row
  // can re-grade its pairing hint once the selected value has settled.
  const modelFieldPopulated = new WeakMap<HTMLSelectElement, Promise<void>>()

  // The plugin detail this open was deep-linked to, held from `settings-open`
  // until `revealPluginDetail()` has rendered the list and opened the fold. Rows
  // are rebuilt on every `refreshPlugins()`, so the target lives out here rather
  // than in a row that a later refresh would replace.
  let pluginDetail: PluginDetailTarget | null = null
  let managedInstalls = new Map<string, PluginInstallRecord>()

  function installReviewDetail(review: PluginInstallReview): HTMLElement {
    const detail = document.createElement('div')
    detail.className = 'plugin-install-review-dialog'
    if (review.description) {
      const description = document.createElement('div')
      description.className = 'plugin-install-review-description'
      description.textContent = review.description
      detail.append(description)
    }
    const provenance = document.createElement('div')
    provenance.className = 'plugin-install-review-provenance'
    provenance.textContent = `Unsigned package from ${review.publisher}`
    detail.append(provenance)

    // What the plugin will add is the decision, so it leads: skills by name (a
    // path's directory is the skill's name) and MCP servers by where they run.
    if (review.skills.length > 0) {
      const chips = document.createElement('div')
      chips.className = 'plugin-chips'
      for (const path of review.skills) {
        const chip = document.createElement('span')
        chip.className = 'plugin-chip'
        chip.textContent = installReviewSkillName(path, review.pluginId)
        chip.title = path
        chips.append(chip)
      }
      detail.append(installReviewSection(countLabel(review.skills.length, 'skill'), chips))
    }
    if (review.mcpServers.length > 0) {
      const servers = document.createElement('ul')
      servers.className = 'plugin-install-review-servers'
      for (const server of review.mcpServers) {
        const item = document.createElement('li')
        const name = document.createElement('span')
        name.className = 'plugin-install-review-server-name'
        name.textContent = server.name
        const transport = document.createElement('span')
        transport.className = 'plugin-install-review-server-transport'
        transport.textContent =
          server.transport === 'stdio'
            ? 'Local command'
            : server.transport === 'sse'
              ? 'Legacy SSE'
              : 'HTTP'
        const target = document.createElement('code')
        target.className = 'plugin-install-review-server-target'
        target.textContent =
          server.transport === 'stdio' ? server.target : server.target.replace(/^https?:\/\//, '')
        item.append(name, transport, target)
        servers.append(item)
      }
      detail.append(
        installReviewSection(countLabel(review.mcpServers.length, 'MCP server'), servers),
      )
    }
    if (review.warnings.length > 0) {
      const warnings = document.createElement('ul')
      warnings.className = 'plugin-install-review-warnings'
      for (const warning of review.warnings) {
        const item = document.createElement('li')
        item.textContent = warning
        warnings.append(item)
      }
      detail.append(warnings)
    }

    // The pin is what makes the review exact, but it is evidence, not the
    // decision: one click away rather than two wrapped lines of hex.
    const pin = document.createElement('details')
    pin.className = 'plugin-install-review-pin'
    const pinSummary = document.createElement('summary')
    pinSummary.className = 'settings-disclosure-summary'
    const pinLabel = document.createElement('span')
    pinLabel.textContent = `Pinned to ${review.revision.slice(0, 7)}`
    pinSummary.append(pinLabel, chevronDownIcon('ui-icon settings-disclosure-chevron'))
    const list = document.createElement('dl')
    list.className = 'plugin-source-details'
    const pinDetails: Array<[string, string]> = [
      ['Revision', review.revision],
      ['Content', review.contentHash],
    ]
    for (const [label, value] of pinDetails) {
      const term = document.createElement('dt')
      term.textContent = label
      const description = document.createElement('dd')
      description.textContent = value
      list.append(term, description)
    }
    pin.append(pinSummary, list)
    detail.append(pin)
    return detail
  }

  async function reviewCatalogInstall(catalogId: string): Promise<void> {
    const review = await api.plugins.prepareInstall(catalogId)
    try {
      const confirmed = await showConfirmDialog({
        message: `${review.operation === 'update' ? 'Update' : 'Install'} ${review.name}?`,
        detail: installReviewDetail(review),
        confirmLabel: review.operation === 'update' ? 'Update' : 'Install',
        confirmPendingLabel: 'Installing…',
        onConfirm: async () => {
          await api.plugins.commitInstall(review.token)
        },
      })
      if (!confirmed) {
        await api.plugins.cancelInstall(review.token)
        return
      }
    } catch (error) {
      await api.plugins.cancelInstall(review.token).catch(() => undefined)
      throw error
    }
    await refreshPlugins()
    store.emit('settings_changed')
  }

  async function rollbackManagedPlugin(record: PluginInstallRecord): Promise<void> {
    const previous = record.previousPin
    if (!previous) return
    const confirmed = await showConfirmDialog({
      message: `Roll back ${record.name}?`,
      detail: `Copse will switch back to revision ${previous.revision.slice(0, 7)}.`,
      confirmLabel: 'Roll back',
      onConfirm: async () => {
        await api.plugins.rollback(record.pluginId)
      },
    })
    if (!confirmed) return
    await refreshPlugins()
    store.emit('settings_changed')
  }

  async function uninstallManagedPlugin(record: PluginInstallRecord): Promise<void> {
    const detail = document.createElement('div')
    const explanation = document.createElement('p')
    explanation.textContent = 'The plugin payload will be removed. Existing thread history is kept.'
    const deleteLabel = document.createElement('label')
    deleteLabel.className = 'plugin-uninstall-data-choice'
    const deleteData = document.createElement('input')
    deleteData.type = 'checkbox'
    deleteLabel.append(deleteData, ' Also delete this plugin’s saved data')
    detail.append(explanation, deleteLabel)
    const confirmed = await showConfirmDialog({
      message: `Uninstall ${record.name}?`,
      detail,
      confirmLabel: 'Uninstall',
      confirmPendingLabel: 'Uninstalling…',
      danger: true,
      onConfirm: async () => {
        await api.plugins.uninstall(record.pluginId, deleteData.checked)
      },
    })
    if (!confirmed) return
    await refreshPlugins()
    store.emit('settings_changed')
  }

  const pluginCatalogBrowser = createPluginCatalogBrowser({
    reviewInstall: reviewCatalogInstall,
    rollback: rollbackManagedPlugin,
    uninstall: uninstallManagedPlugin,
  })
  qsRequired(overlay, '#plugins-browse-panel').append(pluginCatalogBrowser.element)

  function selectPluginView(view: 'installed' | 'browse'): void {
    const installed = view === 'installed'
    const installedTab = qsRequired<HTMLButtonElement>(overlay, '#plugins-installed-tab')
    const browseTab = qsRequired<HTMLButtonElement>(overlay, '#plugins-browse-tab')
    installedTab.classList.toggle('active', installed)
    browseTab.classList.toggle('active', !installed)
    installedTab.setAttribute('aria-selected', installed ? 'true' : 'false')
    browseTab.setAttribute('aria-selected', installed ? 'false' : 'true')
    qsRequired(overlay, '#plugins-installed-panel').hidden = !installed
    qsRequired(overlay, '#plugins-browse-panel').hidden = installed
    if (!installed) pluginCatalogBrowser.focusSearch()
  }

  qsRequired<HTMLButtonElement>(overlay, '#animated-explainers-manage').addEventListener(
    'click',
    () => {
      pluginDetail = { pluginId: MCP_UI_CANVAS_PLUGIN_ID }
      // Navigation can rebuild plugin rows. Reveal only after the active
      // section refresh settles, so the target cannot be consumed by an old row.
      void onNavigate('customise').then(async (signal): Promise<void> => {
        if (signal) await revealPluginDetail(pluginDetail, signal)
      })
    },
  )

  /**
   * Render one plugin row for the Settings → Plugins list (P3 of
   * docs/plans/hooks-and-feature-packs.md). Each row shows the plugin's name and
   * version, its trust tier, an enable/disable toggle, an enumeration of what
   * the plugin contributes (tools / hooks / prompt blocks / panels), and any
   * plugin-scoped settings fields declared by its manifest. Toggling `enabled`
   * calls `plugins:set-enabled`, which flips the shared `PluginRegistry` flag
   * atomically (P1 contract) and persists to `electron-store`.
   */
  function makePluginRow(plugin: import('@shared/types/plugins.ts').PluginSummary): HTMLElement {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    row.dataset['pluginId'] = plugin.id
    row.dataset['enabled'] = plugin.enabled ? 'true' : 'false'

    const header = document.createElement('div')
    header.className = 'plugin-row-header'

    // A plugin is a thing you install, so it gets a mark like one. First-party
    // plugins carry the Copse glyph itself (the real asset, not a redraw); a
    // user-installed plugin must not, or a sideloaded plugin would wear our badge
    // of trust — it gets a neutral tile with its own initial instead.
    const icon = document.createElement('span')
    icon.className = 'plugin-icon'
    icon.setAttribute('aria-hidden', 'true')
    if (plugin.trust === 'first-party') {
      icon.classList.add('plugin-icon-copse')
      const mark = document.createElement('img')
      mark.src = './brand-mark.svg'
      mark.alt = ''
      mark.width = 40
      mark.height = 40
      icon.append(mark)
    } else {
      icon.textContent = (pluginDisplayName(plugin).trim()[0] ?? '?').toUpperCase()
    }
    header.append(icon)

    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'toggle-switch plugin-toggle'
    toggleLabel.title = plugin.enabled ? 'Turn off this plugin' : 'Turn on this plugin'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = plugin.enabled
    toggle.className = 'plugin-toggle-input'
    toggle.setAttribute('aria-label', `${plugin.name} plugin enabled`)
    const track = document.createElement('span')
    track.className = 'toggle-switch-track'
    track.setAttribute('aria-hidden', 'true')
    // Set by a credential-gated plugin (below) once it knows no key is stored, so
    // the change handler's `finally` re-arms the lock instead of clearing it.
    let credentialLocked = false
    toggle.addEventListener('change', () => {
      const settingsOpen = row.querySelector<HTMLDetailsElement>('.plugin-settings-fold')?.open
      toggle.disabled = true
      void api.plugins
        .setEnabled(plugin.id, toggle.checked)
        .then(async () => {
          // Enabling moves the card into Active. Keep its open settings in view
          // so the next setup step (for example enabling explainers) stays reachable.
          await refreshPlugins()
          if (settingsOpen) await revealPluginDetail({ pluginId: plugin.id })
          // Turning a plugin off is exactly what moves its declared MCP servers
          // between "off because the plugin is" and "off because we don't start
          // them yet", so the MCP lens has to follow the toggle rather than wait
          // for the next dialog open.
          onMcpChanged()
          // Wake listeners that gate chrome on plugin enablement (e.g. the
          // Memories / Roadmap titlebar buttons in panel-mode-controls, which
          // read the plugin list) so a toggle takes effect without an app restart —
          // mirrors the `settings_changed` emit the Save button fires. Tool-only
          // plugins still emit for consistency with chrome-gating plugins.
          store.emit('settings_changed')
        })
        .catch(() => {
          toggle.checked = !toggle.checked
        })
        .finally(() => {
          toggle.disabled = credentialLocked && !toggle.checked
        })
    })
    toggleLabel.append(toggle, track)

    // Who published the plugin is the first thing to know about it and the same
    // answer for every row, so it reads as an eyebrow over the name rather than
    // as one more chip competing with it.
    const title = document.createElement('div')
    title.className = 'plugin-row-title'
    const trustBadge = document.createElement('span')
    trustBadge.className =
      plugin.trust === 'first-party'
        ? 'plugin-badge plugin-badge-first-party'
        : 'plugin-badge plugin-badge-user'
    trustBadge.textContent = plugin.trust === 'first-party' ? 'Copse' : 'User'
    title.append(trustBadge)

    const nameLine = document.createElement('div')
    nameLine.className = 'plugin-row-name-line'
    const nameEl = document.createElement('span')
    nameEl.className = 'plugin-name'
    nameEl.textContent = pluginDisplayName(plugin)
    nameLine.append(nameEl)
    if (plugin.version) {
      const versionEl = document.createElement('span')
      versionEl.className = 'plugin-version'
      versionEl.textContent = plugin.version
      nameLine.append(versionEl)
    }
    const stabilityBadge = document.createElement('span')
    stabilityBadge.className = `ui-badge plugin-badge-${plugin.stability}`
    stabilityBadge.textContent = plugin.stability
    stabilityBadge.title =
      plugin.stability === 'experimental'
        ? 'Experimental: behavior and compatibility may change.'
        : 'Stable: supported as part of the current plugin contract.'
    nameLine.append(stabilityBadge)
    title.append(nameLine)

    // A bare switch never says which way is on. The flanking words do, and CSS
    // emphasises whichever side is live off `:checked` — so there is no second
    // copy of the state to keep in sync. They restate the checkbox's own label,
    // hence hidden from assistive tech.
    const toggleControl = document.createElement('div')
    toggleControl.className = 'plugin-toggle-control'
    const makeStateLabel = (side: 'off' | 'on'): HTMLElement => {
      const stateEl = document.createElement('span')
      stateEl.className = 'plugin-toggle-state'
      stateEl.dataset['side'] = side
      stateEl.textContent = side === 'on' ? 'On' : 'Off'
      stateEl.setAttribute('aria-hidden', 'true')
      return stateEl
    }
    toggleControl.append(makeStateLabel('off'), toggleLabel, makeStateLabel('on'))

    header.append(title, toggleControl)
    row.append(header)

    if (plugin.description) {
      const desc = document.createElement('div')
      desc.className = 'plugin-row-desc'
      desc.innerHTML = renderMarkdown(plugin.description)
      row.append(desc)
    }

    const managedInstall = managedInstalls.get(plugin.id)
    if (managedInstall) {
      const review = document.createElement('div')
      review.className = 'plugin-source-review plugin-managed-review'
      const status = document.createElement('div')
      status.className = 'plugin-source-status'
      status.textContent = 'Installed from the Copse catalogue'
      const detailList = document.createElement('dl')
      detailList.className = 'plugin-source-details'
      const details: Array<[string, string]> = [
        ['Revision', managedInstall.source.revision],
        ['Content', managedInstall.contentHash],
        ['Verification', 'Unsigned package'],
      ]
      for (const [term, value] of details) {
        const dt = document.createElement('dt')
        dt.textContent = term
        const dd = document.createElement('dd')
        dd.textContent = value
        detailList.append(dt, dd)
      }
      const actions = document.createElement('div')
      actions.className = 'plugin-managed-actions'
      const operationStatus = document.createElement('span')
      operationStatus.className = 'plugin-catalog-operation-status'
      operationStatus.setAttribute('role', 'status')
      const run = (button: HTMLButtonElement, action: () => Promise<void>): void => {
        button.disabled = true
        operationStatus.textContent = 'Working…'
        void action()
          .catch((error: unknown) => {
            operationStatus.textContent = errorMessage(error)
          })
          .finally(() => {
            button.disabled = false
          })
      }
      if (managedInstall.previousPin) {
        const rollback = document.createElement('button')
        rollback.type = 'button'
        rollback.className = 'ui-btn ui-btn-secondary ui-btn-compact'
        rollback.textContent = 'Roll back'
        rollback.addEventListener('click', () => {
          run(rollback, () => rollbackManagedPlugin(managedInstall))
        })
        actions.append(rollback)
      }
      const uninstall = document.createElement('button')
      uninstall.type = 'button'
      uninstall.className = 'ui-btn ui-btn-danger ui-btn-compact'
      uninstall.textContent = 'Uninstall'
      uninstall.addEventListener('click', () => {
        run(uninstall, () => uninstallManagedPlugin(managedInstall))
      })
      actions.append(uninstall)
      review.append(status, detailList, operationStatus, actions)
      row.append(review)
    } else if (plugin.source?.kind === 'directory') {
      const review = document.createElement('div')
      review.className = 'plugin-source-review'

      const status = document.createElement('div')
      status.className = 'plugin-source-status'
      status.textContent = 'Selected directory · executable behaviors run in isolation'
      review.append(status)

      const details: Array<[string, string]> = [
        ['Source', plugin.source.path],
        ['Content', plugin.source.contentHash],
      ]
      const detailList = document.createElement('dl')
      detailList.className = 'plugin-source-details'
      for (const [term, value] of details) {
        const dt = document.createElement('dt')
        dt.textContent = term
        const dd = document.createElement('dd')
        dd.textContent = value
        detailList.append(dt, dd)
      }
      review.append(detailList)
      row.append(review)
    }

    // Contribution enumeration — the "about:addons" surface: users see exactly
    // what flipping the toggle takes out of new work.
    const contributions = plugin.contributions
    const chips: { label: string; count: number; title?: string }[] = []
    if (contributions.toolNames.length > 0) {
      chips.push({
        label: 'Tools',
        count: contributions.toolNames.length,
        title: contributions.toolNames.join(', '),
      })
    }
    if (contributions.modelRoutes.length > 0) {
      chips.push({
        label: 'Models',
        count: contributions.modelRoutes.length,
        title: contributions.modelRoutes.map((route) => `${route.label} (${route.id})`).join(', '),
      })
    }
    if (contributions.browserOrigins.length > 0) {
      chips.push({
        label: 'Browser origins',
        count: contributions.browserOrigins.length,
        title: contributions.browserOrigins.join(', '),
      })
    }
    if (contributions.mcpServersPath) {
      chips.push({ label: 'MCP config', count: 1, title: contributions.mcpServersPath })
    }
    const hookCount = contributions.blockingHooks.length + contributions.asyncHooks.length
    if (hookCount > 0) {
      const eventList = [
        ...contributions.blockingHooks.map((h) => `${h.id} (${h.event})`),
        ...contributions.asyncHooks.map((h) => `${h.id} (${h.event}, async)`),
      ]
      chips.push({ label: 'Hooks', count: hookCount, title: eventList.join(', ') })
    }
    if (contributions.commandHooks.length > 0) {
      chips.push({
        label: 'Command hooks',
        count: contributions.commandHooks.length,
        title: contributions.commandHooks.map((h) => `${h.event}: ${h.command}`).join(', '),
      })
    }
    if (contributions.promptBlocks.length > 0) {
      chips.push({
        label: 'Prompt blocks',
        count: contributions.promptBlocks.length,
        title: contributions.promptBlocks.map((b) => `${b.id} (${b.trust})`).join(', '),
      })
    }
    if (contributions.ui.length > 0) {
      chips.push({
        label: 'UI',
        count: contributions.ui.length,
        title: contributions.ui
          .map(
            (u) =>
              `L${String(u.level)} ${u.title ?? u.id}${u.panelKind ? ` (${u.panelKind})` : ''}`,
          )
          .join(', '),
      })
    }
    if (contributions.followUps.length > 0) {
      chips.push({
        label: 'Follow-ups',
        count: contributions.followUps.length,
        title: contributions.followUps.map((f) => `${f.label} (${f.action}, ${f.when})`).join(', '),
      })
    }
    if (contributions.capabilities.length > 0) {
      chips.push({
        label: 'Capabilities',
        count: contributions.capabilities.length,
        title: contributions.capabilities.map((c) => `${c.title} (${c.name})`).join(', '),
      })
    }
    if (contributions.instructionSources.length > 0) {
      chips.push({
        label: 'Instruction sources',
        count: contributions.instructionSources.length,
        title: contributions.instructionSources
          .map((source) => `${source.title} (${source.name})`)
          .join(', '),
      })
    }
    if (contributions.permissions.length > 0) {
      chips.push({
        label: 'Permissions',
        count: contributions.permissions.length,
        title: contributions.permissions
          .map((p) => `${p.title} (${p.name}${p.scope ? `, ${p.scope}` : ''})`)
          .join(', '),
      })
    }
    if (chips.length > 0) {
      const chipRow = document.createElement('div')
      chipRow.className = 'plugin-chips'
      for (const chip of chips) {
        const chipEl = document.createElement('span')
        chipEl.className = 'plugin-chip'
        chipEl.textContent = `${chip.label} × ${String(chip.count)}`
        if (chip.title) chipEl.title = chip.title
        chipRow.append(chipEl)
      }
      row.append(chipRow)
    } else {
      const emptyChips = document.createElement('div')
      emptyChips.className = 'plugin-chips-empty'
      emptyChips.textContent = 'Contributes nothing yet (skeleton plugin).'
      row.append(emptyChips)
    }

    // Everything configurable about a plugin folds into one disclosure. The card
    // leads with what the plugin *is* and what it contributes — the decision you
    // make from a list of plugins — and keeps its knobs one click away rather than
    // stacking every plugin's form on top of the next plugin's name. Appended to the
    // row at the end, and only if something landed inside it.
    const settingsFold = document.createElement('details')
    settingsFold.className = 'plugin-settings-fold'
    const settingsSummary = document.createElement('summary')
    settingsSummary.className = 'plugin-settings-summary'
    const settingsSummaryLabel = document.createElement('span')
    settingsSummaryLabel.textContent = 'Plugin settings'
    // `ui-icon` is what carries `fill: none; stroke: currentColor` — an SVG path
    // without it takes the SVG default (filled, unstroked), so this chevron was
    // rendering as a solid triangle rather than the outline stroke every other
    // disclosure in the app uses. The class is replaced, not appended, by
    // outlineIcon, so it has to be named here.
    settingsSummary.append(settingsSummaryLabel, chevronDownIcon('ui-icon plugin-settings-chevron'))
    settingsFold.append(settingsSummary)

    // Generic plugin-scoped settings fields (rendered from the manifest schema).
    if (plugin.settings.length > 0) {
      const settingsBox = document.createElement('div')
      settingsBox.className = 'plugin-settings'
      for (const field of plugin.settings) {
        settingsBox.append(makePluginSettingField(plugin.id, field))
      }
      settingsFold.append(settingsBox)
      // The advisor model field owns the live executor/advisor pairing hint (it
      // moved here from the Experimental section with the model itself). Wire the
      // advisor select + a hint element into the shared refs, keep the `#advisorModel`
      // / `#advisorPairHint` ids other code (and the e2e) locate them by, and
      // re-grade on any change to the advisor model.
      if (plugin.id === ADVISOR_STRATEGY_PLUGIN_ID) {
        const advisorSelect = settingsBox.querySelector<HTMLSelectElement>(
          `.plugin-setting-model[data-setting-key="${ADVISOR_MODEL_SETTING_ID}"]`,
        )
        if (advisorSelect) {
          advisorSelect.id = 'advisorModel'
          const hint = document.createElement('p')
          hint.className = 'field-hint advisor-pair-hint'
          hint.id = 'advisorPairHint'
          hint.hidden = true
          settingsBox.append(hint)
          advisorModelSelectEl = advisorSelect
          advisorPairHintEl = hint
          advisorSelect.addEventListener('change', () => {
            updateAdvisorPairHint()
          })
          // Grade now (covers an already-loaded value), and again once this
          // picker's async catalogue refresh settles. Pairs with the executor-side
          // re-grade in `settings-open`; whichever finishes last reveals the hint.
          updateAdvisorPairHint()
          const populated = modelFieldPopulated.get(advisorSelect)
          if (populated) {
            void populated.then(() => {
              updateAdvisorPairHint()
            })
          }
        }
      }
    }

    // First-party level-3 settings detail. The manifest advertises the named
    // slot in the contribution chips; shipped renderer code supplies the view
    // (user plugins cannot inject arbitrary renderer code, decision 15).
    if (
      plugin.id === AUTOMATIONS_PLUGIN_ID &&
      plugin.contributions.ui.some(
        (contribution) =>
          contribution.level === 3 && contribution.slot === 'settings-plugin-detail',
      )
    ) {
      settingsFold.append(
        createAutomationPluginSettings(
          store,
          api,
          plugin.enabled,
          pluginDetail?.pluginId === plugin.id ? pluginDetail.detailId : undefined,
        ),
      )
    }
    if (
      plugin.id === APPLE_DEVELOPMENT_PLUGIN_ID &&
      plugin.contributions.ui.some(
        (contribution) =>
          contribution.level === 3 && contribution.slot === 'settings-plugin-detail',
      )
    ) {
      settingsFold.append(
        createAppleDevelopmentPanel(store, api, {
          allowEnrollment: true,
          pluginEnabled: plugin.enabled,
        }),
      )
    }
    if (
      plugin.id === PARALLEL_SEARCH_PLUGIN_ID &&
      plugin.contributions.ui.some(
        (contribution) =>
          contribution.level === 3 && contribution.slot === 'settings-plugin-detail',
      )
    ) {
      // Parallel Search is credential-gated end to end: `syncParallelSearchTools`
      // registers `parallel_search` only when the plugin is on AND a key resolves.
      // Without this the switch flips on with no key and nothing happens — an
      // on-looking plugin contributing no tool. Block the on-direction until a key
      // is stored (never the off-direction, or a user who clears their key would
      // be stuck with the plugin showing enabled), and say why in a hint.
      // The gate explains a switch you can see is locked, so it stays on the
      // face of the card — folding the reason away under "Plugin settings" would
      // leave a dead toggle with no explanation next to it.
      const gate = document.createElement('p')
      gate.className = 'field-hint plugin-credential-gate'
      gate.hidden = true
      row.append(gate)
      settingsFold.append(
        createParallelSearchPluginSettings(api, {
          onKeyPresence: (hasKey) => {
            credentialLocked = !hasKey
            toggle.disabled = credentialLocked && !toggle.checked
            gate.hidden = hasKey
            gate.textContent = toggle.checked
              ? 'Add a Parallel API key to let the agent use Parallel search.'
              : 'Add a Parallel API key to turn this plugin on.'
            if (toggle.disabled) toggleLabel.title = 'Add a Parallel API key to turn this plugin on'
          },
        }),
      )
    }

    // A plugin with nothing to configure shows no fold — an empty disclosure is
    // worse than none, because it invites a click that reveals nothing.
    if (settingsFold.childElementCount > 1) row.append(settingsFold)

    // Disabling greys the whole row so the effect of the toggle is immediately
    // visible; individual plugin-scoped settings stay editable so users can
    // configure a disabled plugin before re-enabling it.
    if (!plugin.enabled) row.classList.add('plugin-row-disabled')

    return row
  }

  function makePluginSettingField(
    pluginId: string,
    field: import('@shared/types/plugins.ts').PluginSettingFieldSummary,
  ): HTMLElement {
    const label = document.createElement('label')
    label.className = 'plugin-setting-field'
    const title = document.createElement('span')
    title.className = 'plugin-setting-title'
    title.textContent = field.title
    label.append(title)

    let input: HTMLInputElement | HTMLSelectElement
    let modelFieldCurrent: string | undefined
    let modelSelectInput: HTMLSelectElement | null = null
    if (field.kind === 'boolean') {
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = field.value === true
      checkbox.className = 'plugin-setting-input plugin-setting-boolean'
      input = checkbox
    } else if (field.kind === 'enum') {
      const select = document.createElement('select')
      select.className = 'plugin-setting-input plugin-setting-enum'
      for (const option of field.options ?? []) {
        const opt = document.createElement('option')
        opt.value = option
        opt.textContent = option
        if (option === field.value) opt.selected = true
        select.append(opt)
      }
      input = select
    } else if (field.kind === 'number') {
      const number = document.createElement('input')
      number.type = 'number'
      number.value = String(field.value)
      number.className = 'plugin-setting-input plugin-setting-number'
      input = number
    } else if (field.kind === 'model') {
      // Model settings use the same searchable, provider-grouped picker as the
      // composer. The manifest stores only the current id; options stay live.
      const select = document.createElement('select')
      select.className = 'plugin-setting-input plugin-setting-model'
      modelFieldCurrent = typeof field.value === 'string' ? field.value : ''
      modelSelectInput = select
      input = select
    } else {
      const text = document.createElement('input')
      text.type = 'text'
      text.value = typeof field.value === 'string' ? field.value : String(field.value)
      text.className = 'plugin-setting-input plugin-setting-string'
      input = text
    }
    input.dataset['pluginId'] = pluginId
    input.dataset['settingKey'] = field.id

    // Persist on change so the manifest schema is the source of truth — no
    // Save-button plumbing needed, mirroring the MCP per-server toggle.
    input.addEventListener('change', () => {
      let value: unknown = input.value
      if (field.kind === 'boolean') {
        if (!(input instanceof HTMLInputElement)) {
          throw new Error('Boolean plugin setting must render as an input')
        }
        value = input.checked
      } else if (field.kind === 'number') {
        value = Number(input.value)
      }
      void api.plugins.setSetting(pluginId, field.id, value).catch(() => {
        // Best-effort: on failure the on-screen value stays; next reload
        // resyncs to storage.
      })
    })

    label.append(input)
    if (modelSelectInput) {
      // A plugin's model field selects a *rule*, not a model: plugins run
      // unattended long after this dialog was last open, so the picker offers
      // dynamic selections only (see `dynamicModelOptions`). A field the
      // manifest gave no default has a meaningful blank state — the owning
      // feature's own fallback — so that stays selectable.
      const autoLabel = field.default === undefined ? '(use this feature’s default)' : undefined
      const picker = mountModelSelectPicker(modelSelectInput, {
        loadOptions: (current) => fetchDynamicModelOptions(current, autoLabel),
        ariaLabel: field.title,
        loadOnMount: false,
      })
      qsRequired(picker.root, '.model-picker-trigger').setAttribute(
        'data-model-setting-target',
        `plugin:${pluginId}:${field.id}`,
      )
      modelFieldPopulated.set(
        modelSelectInput,
        picker.refresh(modelFieldCurrent ?? '', activeSignal),
      )
    }
    if (field.description) {
      const hint = document.createElement('span')
      hint.className = 'plugin-setting-desc'
      // Manifest copy is markdown (backticked setting names, links), like the
      // pack description above it.
      hint.innerHTML = renderMarkdown(field.description)
      label.append(hint)
    }
    if (modelSelectInput) label.append(mountResolvedModelHint(modelSelectInput))
    return label
  }

  /**
   * Live "→ currently <model>" line under a dynamic model picker. The rule is
   * what gets stored, but the user still deserves to see which model it names
   * today — that is the one thing a selector hides that a pinned id showed.
   */
  function mountResolvedModelHint(select: HTMLSelectElement): HTMLElement {
    const hint = document.createElement('span')
    hint.className = 'plugin-setting-resolved'
    hint.hidden = true
    let generation = 0
    const update = (): void => {
      const value = select.value
      const mine = ++generation
      if (!value) {
        hint.hidden = true
        return
      }
      void api.models
        .resolveDynamic(value)
        .then((resolved) => {
          // Ignore a slow answer for a selection the user has already changed.
          if (mine !== generation || activeSignal?.aborted) return
          hint.hidden = !resolved || resolved === value
          hint.textContent = `Currently resolves to ${modelDisplayLabel(resolved)}`
        })
        .catch(() => {
          if (mine === generation) hint.hidden = true
        })
    }
    select.addEventListener('change', update)
    update()
    return hint
  }

  // Keep one live row per plugin: custom panels and model pickers own state and
  // element ids. Move experimental rows into the active section instead of
  // mounting duplicate controls, and return them to Customise on navigation.
  let pluginEntries: { enabled: boolean; experimental: boolean; row: HTMLElement }[] | null = null

  function renderPluginLists(): void {
    // Cross-section search should only collect the fieldset holding the rows.
    qsRequired(overlay, '#experimental-plugins-fieldset').hidden =
      getActiveSection() !== 'experimental'
    if (!pluginEntries) return
    for (const experimental of [false, true]) {
      const listEl = qsRequired(
        overlay,
        experimental ? '#experimental-plugins-list' : '#plugins-list',
      )
      const entries = pluginEntries.filter(
        (entry) => (getActiveSection() === 'experimental' && entry.experimental) === experimental,
      )
      listEl.replaceChildren()
      let lastEnabled: boolean | null = null
      for (const entry of entries) {
        if (entry.enabled !== lastEnabled) {
          const heading = document.createElement('h4')
          heading.className = 'plugins-group-heading'
          heading.textContent = entry.enabled ? 'Active' : 'Inactive'
          listEl.append(heading)
          lastEnabled = entry.enabled
        }
        listEl.append(entry.row)
      }
      if (entries.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'plugins-empty'
        empty.textContent = experimental
          ? 'No experimental plugins installed.'
          : 'No plugins installed.'
        listEl.append(empty)
      }
    }
  }

  let pluginRefreshGeneration = 0

  let activeSignal: AbortSignal | undefined
  async function refreshPlugins(signal: AbortSignal | undefined = activeSignal): Promise<void> {
    activeSignal = signal
    if (signal?.aborted) return
    const generation = ++pluginRefreshGeneration
    const statusEls = overlay.querySelectorAll('.plugins-load-status')
    const setStatus = (text: string): void => {
      statusEls.forEach((el) => {
        el.textContent = text
      })
    }
    setStatus('Loading…')
    try {
      // Two origins, one list. The registry owns lifecycle for everything Copse
      // installed; Cursor owns its own cache, so those rows are read-only. A
      // Cursor failure must not blank the registry rows beside it, hence the
      // catch rather than a bare Promise.all.
      const [result, cursorPlugins, bundledPlugins, installs] = await Promise.all([
        api.plugins.list(),
        api.cursorPlugins.list().catch(() => []),
        api.bundledSkillPlugins.list().catch(() => []),
        api.plugins.listInstalls(),
      ])
      if (generation !== pluginRefreshGeneration || signal?.aborted) return
      managedInstalls = new Map(installs.map((record) => [record.pluginId, record]))
      pluginCatalogBrowser.updateInstalled({
        cursor: cursorPlugins.map((plugin) => plugin.name),
        bundledCursor: bundledPlugins.map((plugin) => plugin.name),
        managed: installs,
      })

      // Enabled plugins first, disabled plugins after — so a scrapped plugin moves
      // out of the way instead of sitting in the middle of the list. The two
      // runs get a heading each: with rows this tall, "why is this one dimmed"
      // is a question the list should answer before it is asked. A heading is
      // skipped when nothing falls under it.
      // One sequence, whatever installed the plugin. A Cursor plugin sorts in
      // as `enabled: true` because it genuinely is — nothing gates
      // `~/.cursor/plugins`, so it is contributing exactly like the rows
      // around it, and the reader's question is "is this on", not "who
      // packaged it". Origin is a badge on the row, not a section.
      const entries = [
        ...result.plugins.map((plugin) => ({
          id: plugin.id,
          enabled: plugin.enabled,
          experimental: plugin.stability === 'experimental',
          render: (): HTMLElement => makePluginRow(plugin),
        })),
        ...cursorPlugins.map((plugin) => ({
          id: plugin.name,
          enabled: true,
          experimental: false,
          render: (): HTMLElement => makeCursorPluginRow(plugin),
        })),
        ...bundledPlugins.map((plugin) => ({
          id: plugin.name,
          enabled: plugin.enabled && !plugin.suppressed,
          experimental: false,
          render: (): HTMLElement => makeBundledSkillPluginRow(plugin),
        })),
      ].sort((a, b) => Number(!a.enabled) - Number(!b.enabled) || a.id.localeCompare(b.id))

      pluginEntries = entries.map((entry) => ({
        enabled: entry.enabled,
        experimental: entry.experimental,
        row: entry.render(),
      }))
      renderPluginLists()
      setStatus('')
    } catch {
      if (generation === pluginRefreshGeneration) setStatus('Failed to load plugins.')
    }
  }

  /**
   * A Cursor-installed plugin, rendered as an ordinary plugin row.
   *
   * It gets the same shape as every other row — icon, origin badge, name,
   * switch, contributions — because a user asking "what is extending Copse"
   * should not have to learn that one answer lives in a differently-shaped card
   * at the bottom of the list.
   *
   * **It reports Active, and that is a claim worth being sure of.** Nothing
   * gates `~/.cursor/plugins`: `skills-registry.ts` adds every discovered
   * plugin's skills directory unconditionally, and `mcp-registry.ts` reads
   * every discovered plugin's MCP config the same way. So an installed Cursor
   * plugin is always contributing, and the row says so.
   *
   * The switch is therefore shown **on and disabled**. Cursor owns the
   * lifecycle, so this is the honest rendering: the state is real, and the
   * control is visibly not ours to move. Omitting the switch entirely was worse
   * — it left the one question the list exists to answer unanswered.
   */
  function makeCursorPluginRow(
    plugin: import('@shared/types/cursor-plugins.ts').CursorPluginSummary,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    row.dataset['pluginId'] = plugin.name
    row.dataset['pluginOrigin'] = 'cursor'
    row.dataset['enabled'] = 'true'

    const header = document.createElement('div')
    header.className = 'plugin-row-header'

    // Cursor's own cube mark, the real asset — the same reasoning that gives a
    // first-party row the Copse glyph and a sideloaded one a neutral initial:
    // a mark stands for who made the thing, so it is theirs to draw, not ours.
    // It keeps the neutral tile rather than the Copse mark's neon field, which
    // would read as our endorsement of someone else's plugin.
    const icon = document.createElement('span')
    icon.className = 'plugin-icon plugin-icon-cursor'
    icon.setAttribute('aria-hidden', 'true')
    const mark = document.createElement('img')
    mark.src = './cursor-mark.svg'
    mark.alt = ''
    icon.append(mark)
    header.append(icon)

    const title = document.createElement('div')
    title.className = 'plugin-row-title'
    const originBadge = document.createElement('span')
    originBadge.className = 'plugin-badge plugin-badge-cursor'
    originBadge.textContent = 'Cursor'
    originBadge.title = 'Installed through Cursor. Cursor manages this plugin.'
    title.append(originBadge)

    const nameLine = document.createElement('div')
    nameLine.className = 'plugin-row-name-line'
    const nameEl = document.createElement('span')
    nameEl.className = 'plugin-name'
    nameEl.textContent = plugin.name
    nameLine.append(nameEl)
    if (plugin.version) {
      const versionEl = document.createElement('span')
      versionEl.className = 'plugin-version'
      versionEl.textContent = plugin.version
      nameLine.append(versionEl)
    }
    title.append(nameLine)

    const toggleControl = document.createElement('div')
    toggleControl.className = 'plugin-toggle-control'
    const makeStateLabel = (side: 'off' | 'on'): HTMLElement => {
      const stateEl = document.createElement('span')
      stateEl.className = 'plugin-toggle-state'
      stateEl.dataset['side'] = side
      stateEl.textContent = side === 'on' ? 'On' : 'Off'
      stateEl.setAttribute('aria-hidden', 'true')
      return stateEl
    }
    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'toggle-switch plugin-toggle'
    toggleLabel.title = 'Managed by Cursor. Open Cursor to turn it off.'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = true
    toggle.disabled = true
    toggle.className = 'plugin-toggle-input'
    toggle.setAttribute('aria-label', `${plugin.name} plugin enabled (managed by Cursor)`)
    const track = document.createElement('span')
    track.className = 'toggle-switch-track'
    track.setAttribute('aria-hidden', 'true')
    toggleLabel.append(toggle, track)
    toggleControl.append(makeStateLabel('off'), toggleLabel, makeStateLabel('on'))

    header.append(title, toggleControl)
    row.append(header)

    if (plugin.description) {
      const desc = document.createElement('div')
      desc.className = 'plugin-row-desc'
      desc.innerHTML = renderMarkdown(plugin.description)
      row.append(desc)
    }

    const chips = document.createElement('div')
    chips.className = 'plugin-chips'
    const contributes: string[] = []
    if (plugin.skillsDir) contributes.push('Skills')
    if (plugin.mcpConfigPath) contributes.push('MCP servers')
    if (contributes.length === 0) {
      const none = document.createElement('span')
      none.className = 'plugin-chips-empty'
      none.textContent = 'Contributes nothing Copse can load'
      chips.append(none)
    } else {
      for (const label of contributes) {
        const chip = document.createElement('span')
        chip.className = 'plugin-chip'
        chip.textContent = label
        chips.append(chip)
      }
    }
    row.append(chips)

    const path = document.createElement('p')
    path.className = 'plugin-source-path'
    path.textContent = plugin.root
    row.append(path)

    return row
  }

  /**
   * A Cursor plugin whose skills ship inside Copse, with a switch that is ours.
   *
   * Same row shape as a Cursor-installed plugin — the Cursor mark, because
   * Cursor wrote it — but Copse vendors it, so the switch is live. The choice
   * is saved per plugin, so a default can change in a later release without
   * overriding what the user picked. A plugin that ships switched off says why
   * on the face of the row, next to the switch it explains.
   */
  function makeBundledSkillPluginRow(
    plugin: import('@shared/types/cursor-plugins.ts').BundledSkillPluginSummary,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    row.dataset['pluginId'] = plugin.name
    row.dataset['pluginOrigin'] = 'bundled'
    row.dataset['enabled'] = String(plugin.enabled && !plugin.suppressed)

    const header = document.createElement('div')
    header.className = 'plugin-row-header'

    const icon = document.createElement('span')
    icon.className = 'plugin-icon plugin-icon-cursor'
    icon.setAttribute('aria-hidden', 'true')
    const mark = document.createElement('img')
    mark.src = './cursor-mark.svg'
    mark.alt = ''
    icon.append(mark)
    header.append(icon)

    const title = document.createElement('div')
    title.className = 'plugin-row-title'
    const originBadge = document.createElement('span')
    originBadge.className = 'plugin-badge plugin-badge-cursor'
    originBadge.textContent = 'Cursor · Bundled'
    originBadge.title = 'Written for Cursor; ships inside Copse from a pinned, reviewed snapshot.'
    title.append(originBadge)

    const nameLine = document.createElement('div')
    nameLine.className = 'plugin-row-name-line'
    const nameEl = document.createElement('span')
    nameEl.className = 'plugin-name'
    nameEl.textContent = plugin.name
    nameLine.append(nameEl)
    if (plugin.version) {
      const versionEl = document.createElement('span')
      versionEl.className = 'plugin-version'
      versionEl.textContent = plugin.version
      nameLine.append(versionEl)
    }
    title.append(nameLine)

    const toggleControl = document.createElement('div')
    toggleControl.className = 'plugin-toggle-control'
    const makeStateLabel = (side: 'off' | 'on'): HTMLElement => {
      const stateEl = document.createElement('span')
      stateEl.className = 'plugin-toggle-state'
      stateEl.dataset['side'] = side
      stateEl.textContent = side === 'on' ? 'On' : 'Off'
      stateEl.setAttribute('aria-hidden', 'true')
      return stateEl
    }
    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'toggle-switch plugin-toggle'
    toggleLabel.title = plugin.suppressed
      ? 'All bundled skills are off. Turn them on under Agent → Skills.'
      : plugin.enabled
        ? 'Turn off this plugin'
        : 'Turn on this plugin'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = plugin.enabled
    toggle.disabled = plugin.suppressed
    toggle.className = 'plugin-toggle-input'
    toggle.setAttribute('aria-label', `${plugin.name} plugin enabled`)
    const track = document.createElement('span')
    track.className = 'toggle-switch-track'
    track.setAttribute('aria-hidden', 'true')
    toggle.addEventListener('change', () => {
      toggle.disabled = true
      void (async (): Promise<void> => {
        const stored = await api.settings.get('bundledSkillPluginOverrides')
        await api.settings.set('bundledSkillPluginOverrides', {
          ...(isRecord(stored) ? stored : {}),
          [plugin.name]: toggle.checked,
        })
        await refreshPlugins()
        // The skill catalog, /-picker and context meter all read the skills
        // registry, which main has just reloaded; wake the listeners that show them.
        store.emit('settings_changed')
      })()
        .catch(() => {
          toggle.checked = !toggle.checked
        })
        .finally(() => {
          toggle.disabled = plugin.suppressed
        })
    })
    toggleLabel.append(toggle, track)
    toggleControl.append(makeStateLabel('off'), toggleLabel, makeStateLabel('on'))

    header.append(title, toggleControl)
    row.append(header)

    if (plugin.description) {
      const desc = document.createElement('div')
      desc.className = 'plugin-row-desc'
      desc.textContent = plugin.description
      row.append(desc)
    }

    if (plugin.offByDefaultReason) {
      const note = document.createElement('p')
      note.className = 'field-hint plugin-default-off-note'
      note.textContent = `Off by default. ${plugin.offByDefaultReason}`
      row.append(note)
    }

    const chips = document.createElement('div')
    chips.className = 'plugin-chips'
    const chip = document.createElement('span')
    chip.className = 'plugin-chip'
    chip.textContent = `${String(plugin.skillCount)} ${plugin.skillCount === 1 ? 'skill' : 'skills'}`
    chips.append(chip)
    row.append(chips)

    return row
  }

  async function revealPluginDetail(
    target = pluginDetail,
    signal: AbortSignal | undefined = activeSignal,
  ): Promise<void> {
    if (!target || signal?.aborted) return
    // Search may retain Customise while cancelling the shared Experimental owner.
    // Subsequent mutations must refresh under the visible section's lifetime.
    activeSignal = signal
    if (!pluginEntries) await refreshPlugins(signal)
    if (signal?.aborted) return
    pluginDetail = null
    const row = overlay.querySelector<HTMLElement>(
      `.plugin-row[data-plugin-id="${CSS.escape(target.pluginId)}"]`,
    )
    if (!row) return
    selectPluginView('installed')
    const fold = row.querySelector<HTMLDetailsElement>('.plugin-settings-fold')
    if (fold) fold.open = true
    row.scrollIntoView({ block: 'start' })
  }

  qsRequired(overlay, '#plugins-reload-btn').addEventListener('click', () => {
    void refreshPlugins()
  })

  qsRequired(overlay, '#plugins-installed-tab').addEventListener('click', () => {
    selectPluginView('installed')
  })

  qsRequired(overlay, '#plugins-browse-tab').addEventListener('click', () => {
    selectPluginView('browse')
  })

  qsRequired(overlay, '#plugins-add-btn').addEventListener('click', () => {
    const button = qsRequired<HTMLButtonElement>(overlay, '#plugins-add-btn')
    const status = qsRequired(overlay, '#plugins-reload-status')
    button.disabled = true
    status.textContent = 'Choose a folder containing copse-plugin.json…'
    void api.plugins
      .addSource()
      .then(() => refreshPlugins())
      .catch((error: unknown) => {
        status.textContent = errorMessage(error)
      })
      .finally(() => {
        button.disabled = false
      })
  })

  // Live advisor-pair assessment (docs/plans/advisor-strategy.md): grade the
  // (executor, advisor) pairing from the model capability annotations — cloud
  // tiers and the local catalog — whenever either picker changes, so the user
  // learns up front whether the advisor is actually stronger than the executor.
  // Either side may be a dynamic selection, so both are resolved first — this
  // counter drops a slow answer for a pairing the user has already changed.
  let advisorPairGeneration = 0

  function updateAdvisorPairHint(): void {
    const hint = advisorPairHintEl
    const advisorSelect = advisorModelSelectEl
    if (!hint || !advisorSelect) return
    const form = qsRequired<HTMLFormElement>(overlay, 'form')
    const executor = selectControl(form, 'model').value
    const advisor = advisorSelect.value
    const mine = ++advisorPairGeneration
    if (!executor || !advisor) {
      hint.hidden = true
      return
    }
    // Both sides may be rules rather than model ids. Grade the models they name
    // right now — a hint about `auto:best-intellect` would say nothing useful,
    // and the whole point of the pairing hint is a concrete capability
    // comparison. `resolveDynamic` returns a pinned id unchanged.
    void Promise.all([api.models.resolveDynamic(executor), api.models.resolveDynamic(advisor)])
      .then(([resolvedExecutor, resolvedAdvisor]) => {
        if (mine !== advisorPairGeneration) return
        const assessment = validateAdvisorPair(resolvedExecutor, resolvedAdvisor)
        const dynamic = resolvedAdvisor !== advisor || resolvedExecutor !== executor
        hint.textContent = dynamic
          ? `${assessment.reason} (currently ${modelDisplayLabel(resolvedExecutor)} → ${modelDisplayLabel(resolvedAdvisor)})`
          : assessment.reason
        hint.setAttribute('data-level', assessment.level)
        hint.hidden = false
      })
      .catch(() => {
        if (mine !== advisorPairGeneration) return
        // Resolution unavailable: grade what is stored. A selector lands on the
        // dynamic branch of `validateAdvisorPair`, which says exactly that.
        const assessment = validateAdvisorPair(executor, advisor)
        hint.textContent = assessment.reason
        hint.setAttribute('data-level', assessment.level)
        hint.hidden = false
      })
  }

  return {
    refresh: refreshPlugins,
    render: renderPluginLists,
    reveal: (signal): Promise<void> => revealPluginDetail(pluginDetail, signal),
    updateAdvisorPairHint,
    setDetail: (target: PluginDetailTarget | null): void => {
      pluginDetail = target
    },
    invalidate: (): void => {
      pluginRefreshGeneration += 1
      advisorPairGeneration += 1
    },
  }
}
