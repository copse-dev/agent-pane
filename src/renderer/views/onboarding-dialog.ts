// First-run setup: one screen that scans non-sensitive machine state (local
// model servers and installed ACP agents) as soon as it opens. Reading API keys
// from the environment or shell startup files requires an explicit click; any
// findings then join the same pre-checked list and import on Finish. When no
// usable model source is found, the Settings providers panel mounts in place so
// the user can set one up by hand. Dismissing in any form (Skip, ✕, Esc) marks
// onboarding complete — it never nags twice.

import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { qsRequired, el, clear } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import { createOverlayDialog, type OverlayDialog } from './dialog-shell.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createProvidersPanel } from './setup/providers-section.ts'
import { createDetectedItemRow, providerLabel } from './setup/detected-item-row.ts'
import {
  runOnboardingScan,
  hasUsableFindings,
  importScanFindings,
  deriveDefaultSettings,
  type OnboardingDefaults,
  type ScanFindings,
  type ScanSelection,
} from './setup/onboarding-scan.ts'

let shell: OverlayDialog | null = null

export function openOnboardingDialog(): void {
  if (!shell || shell.isOpen()) return
  shell.open()
  shell.dialog.dispatchEvent(new Event('onboarding-open'))
}

export function closeOnboardingDialog(): void {
  shell?.close()
}

export function isOnboardingDialogOpen(): boolean {
  return !!shell && shell.isOpen()
}

export async function shouldShowOnboarding(api: ApiClient): Promise<boolean> {
  const completed = await api.settings.get('onboardingCompleted')
  return completed !== true
}

export function mountOnboardingDialog(store: AppStore, api: ApiClient): void {
  const dialogShell = createOverlayDialog({
    id: 'onboarding-dialog',
    className: 'onboarding-overlay settings-overlay',
  })
  shell = dialogShell
  const overlay = dialogShell.dialog
  overlay.innerHTML = `
    <div class="onboarding-shell settings-shell">
      <header class="settings-header onboarding-header">
        <h2>Welcome to Copse</h2>
        <button type="button" class="settings-close-btn" id="onboarding-close" aria-label="Close setup" data-tooltip="Close setup"></button>
      </header>

      <p class="onboarding-tagline">
        Copse looks for local model servers and coding agents already on this machine,
        and can import provider API keys when you ask it to.
      </p>

      <div class="onboarding-body">
        <fieldset class="onboarding-env-scan">
          <legend>API keys in your environment</legend>
          <p class="field-hint">
            Copse can check your exported environment and shell startup files for provider
            keys. Nothing is read until you choose Scan environment.
          </p>
          <div class="env-key-actions">
            <button type="button" class="ui-btn ui-btn-secondary" id="onboarding-scan-env">
              Scan environment
            </button>
            <span class="key-status" id="onboarding-env-status" role="status"></span>
          </div>
        </fieldset>
        <section id="onboarding-scan-panel">
          <fieldset>
            <legend>Found on this machine</legend>
            <p class="onboarding-scan-status field-hint" role="status">Scanning…</p>
            <div class="onboarding-scan-results"></div>
          </fieldset>
          <p class="field-hint">
            Untick anything you don’t want. Keys found in your shell files are imported
            into Copse’s own storage and never overwrite one you already saved. You can
            change everything later in Settings, under General.
          </p>
        </section>
        <section id="onboarding-fallback-panel" hidden></section>
      </div>

      <footer class="onboarding-footer">
        <button type="button" class="onboarding-skip" id="onboarding-skip">Skip for now</button>
        <button type="button" id="onboarding-finish" class="onboarding-primary" disabled>
          Use these &amp; finish
        </button>
      </footer>
    </div>
  `

  const scanPanel = qsRequired(overlay, '#onboarding-scan-panel')
  const fallbackPanel = qsRequired(overlay, '#onboarding-fallback-panel')
  const statusEl = qsRequired(overlay, '.onboarding-scan-status')
  const resultsEl = qsRequired(overlay, '.onboarding-scan-results')
  const finishBtn = qsRequired<HTMLButtonElement>(overlay, '#onboarding-finish')
  const envScanBtn = qsRequired<HTMLButtonElement>(overlay, '#onboarding-scan-env')
  const envStatusEl = qsRequired(overlay, '#onboarding-env-status')

  let mode: 'scan' | 'fallback' = 'scan'
  let findings: ScanFindings | null = null
  let scanning = false
  let scanPromise: Promise<void> | null = null
  // Set by the finish path so the close listener doesn't double-write; every
  // other way out (Skip, ✕, Esc) is a dismissal that still completes onboarding.
  let completed = false

  // The fallback providers panel is built on first use — most runs never need it.
  let fallback: {
    panel: ReturnType<typeof createProvidersPanel>
    lmStudio: ReturnType<typeof createLmStudioSection>
  } | null = null

  function setStatus(text: string, kind: 'ok' | 'warn' | 'err' | '' = ''): void {
    statusEl.textContent = text
    statusEl.className = `onboarding-scan-status field-hint${kind ? ` ${kind}` : ''}`
  }

  function renderChecklist(found: ScanFindings): void {
    clear(resultsEl)
    const groups: { title: string; rows: HTMLElement[] }[] = []

    const keyRows = found.envKeys.map(
      (key) =>
        createDetectedItemRow({
          kind: 'env-key',
          id: key.provider,
          label: providerLabel(key.provider),
          detail: `${key.envVar} · ${key.source}`,
          masked: key.masked,
          status: key.alreadyConfigured
            ? { text: 'already set' }
            : { text: 'will import', ok: true },
          checkbox: { checked: !key.alreadyConfigured, disabled: key.alreadyConfigured },
        }).root,
    )
    if (keyRows.length) groups.push({ title: 'Cloud API keys', rows: keyRows })

    const serverRows = found.localServers
      .filter((server) => server.reachable)
      .map(
        (server) =>
          createDetectedItemRow({
            kind: 'local-server',
            id: server.id,
            label: server.label,
            detail: server.baseUrl,
            status: { text: `running, ${String(server.models.length)} model(s)`, ok: true },
            checkbox: { checked: true },
          }).root,
      )
    if (found.lmStudio?.running) {
      serverRows.push(
        createDetectedItemRow({
          kind: 'local-server',
          id: 'lmstudio',
          label: 'LM Studio',
          detail: found.lmStudio.serverUrl,
          status: {
            text: `running, ${String(found.lmStudio.models.length)} model(s) — used automatically`,
            ok: true,
          },
        }).root,
      )
    } else if (found.lmStudio?.installed) {
      serverRows.push(
        createDetectedItemRow({
          kind: 'local-server',
          id: 'lmstudio',
          label: 'LM Studio',
          detail: found.lmStudio.serverUrl,
          status: { text: 'installed — start its server to use it' },
        }).root,
      )
    }
    if (serverRows.length) groups.push({ title: 'Local model servers', rows: serverRows })

    const agentRows = found.acpAgents
      .filter((agent) => agent.installed)
      .map(
        (agent) =>
          createDetectedItemRow({
            kind: 'acp-agent',
            id: agent.id,
            label: agent.title,
            detail: agent.path ?? agent.command,
            status: { text: agent.running ? 'running' : 'installed', ok: true },
            checkbox: { checked: true },
          }).root,
      )
    if (agentRows.length) groups.push({ title: 'Agents on this machine', rows: agentRows })

    for (const group of groups) {
      resultsEl.append(el('p', { class: 'onboarding-scan-group' }, group.title), ...group.rows)
    }

    const failures = found.errors.map((error) => `${error.probe}: ${error.message}`)
    setStatus(
      failures.length
        ? `Some checks failed (${failures.join('; ')}) — the rest is listed below.`
        : 'Here’s what Copse found. Untick anything you don’t want.',
      failures.length ? 'warn' : 'ok',
    )
    finishBtn.disabled = false
  }

  function readSelection(): ScanSelection {
    const picked = (kind: string): string[] =>
      [
        ...resultsEl.querySelectorAll<HTMLInputElement>(
          `[data-kind="${kind}"] input.detected-item-check:checked:not(:disabled)`,
        ),
      ].map((box) => box.closest<HTMLElement>('[data-kind]')?.dataset['id'] ?? '')
    return {
      envKeyProviders: picked('env-key'),
      localServerIds: picked('local-server'),
      acpAgentIds: picked('acp-agent'),
    }
  }

  function showFallback(): void {
    mode = 'fallback'
    scanPanel.hidden = true
    fallbackPanel.hidden = false
    finishBtn.textContent = 'Finish'
    finishBtn.disabled = false
    if (!fallback) {
      const lmStudio = createLmStudioSection(api, { showInstallGuide: true })
      const panel = createProvidersPanel(api, {
        nativeLocalProviders: [
          {
            id: 'lmstudio',
            label: 'LM Studio',
            element: lmStudio.root,
            refresh: (): Promise<void> => lmStudio.refreshDetection(),
          },
        ],
        // First run must stay side-effect-free: no adapter installs until the
        // user actually uses an agent.
        deviceAutoSetup: false,
      })
      fallbackPanel.append(
        el(
          'p',
          { class: 'settings-section-desc' },
          'Nothing set up yet — pick a provider to get started. Add an API key for ' +
            'cloud models, or point Copse at a model server on this machine.',
        ),
        panel.root,
      )
      fallback = { panel, lmStudio }
    }
    void fallback.panel.refresh()
  }

  async function runScan(): Promise<void> {
    if (scanning) return
    scanning = true
    finishBtn.disabled = true
    setStatus('Scanning…')
    try {
      findings = await runOnboardingScan(api)
      if (hasUsableFindings(findings)) {
        renderChecklist(findings)
      } else {
        showFallback()
      }
    } finally {
      scanning = false
    }
  }

  async function scanEnvironment(): Promise<void> {
    envScanBtn.disabled = true
    finishBtn.disabled = true
    envStatusEl.className = 'key-status'
    envStatusEl.textContent = 'Scanning…'
    try {
      // Let the automatic, non-sensitive probes settle first so their findings
      // cannot overwrite the key rows this explicit scan is about to add.
      await scanPromise
      // The click is the opt-in. Persist it before invoking the main-process
      // scan, which independently enforces the same consent gate.
      await api.settings.set('envKeyAutoDetectEnabled', true)
      const envKeys = await api.settings.scanEnvKeys()
      const current = findings ?? {
        envKeys: [],
        localServers: [],
        acpAgents: [],
        lmStudio: null,
        errors: [],
      }
      findings = { ...current, envKeys }
      const importable = envKeys.filter((key) => !key.alreadyConfigured)
      if (importable.length > 0 && mode === 'fallback') {
        mode = 'scan'
        fallbackPanel.hidden = true
        scanPanel.hidden = false
        finishBtn.textContent = 'Use these & finish'
      }
      if (mode === 'scan') renderChecklist(findings)
      envStatusEl.className = `key-status${importable.length > 0 ? ' ok' : ''}`
      envStatusEl.textContent =
        importable.length > 0
          ? `Found ${String(importable.length)} key${importable.length === 1 ? '' : 's'}.`
          : 'No new provider keys found.'
    } catch (err) {
      envStatusEl.className = 'key-status err'
      envStatusEl.textContent = err instanceof Error ? err.message : 'Environment scan failed'
    } finally {
      envScanBtn.disabled = false
      finishBtn.disabled = false
    }
  }

  async function writeDefaultsAndComplete(defaults: OnboardingDefaults): Promise<void> {
    for (const [key, value] of Object.entries(defaults)) {
      await api.settings.set(key, value)
    }
    await api.settings.set('onboardingCompleted', true)
    completed = true
    store.setState({
      settings: { ...store.getState().settings, ...defaults },
    })
    store.emit('settings_changed')
  }

  async function finishSetup(): Promise<void> {
    finishBtn.disabled = true
    try {
      const found = findings ?? {
        envKeys: [],
        localServers: [],
        acpAgents: [],
        lmStudio: null,
        errors: [],
      }
      const selection =
        mode === 'scan'
          ? readSelection()
          : { envKeyProviders: [], localServerIds: [], acpAgentIds: [] }
      const importErrors: string[] = []
      if (mode === 'scan') {
        const result = await importScanFindings(api, found, selection)
        importErrors.push(...result.errors)
      } else if (fallback) {
        try {
          await fallback.panel.saveKeys()
        } catch (err) {
          importErrors.push(err instanceof Error ? err.message : 'Could not save keys')
        }
      }
      // Imports that failed are reported but don't hold onboarding hostage —
      // everything here is redoable from Settings.
      if (importErrors.length) setStatus(importErrors.join(' · '), 'err')
      await writeDefaultsAndComplete(
        deriveDefaultSettings(mode === 'scan' ? found : { ...found, lmStudio: null }, selection),
      )
      dialogShell.close()
    } finally {
      finishBtn.disabled = false
    }
  }

  finishBtn.addEventListener('click', () => {
    void finishSetup()
  })
  envScanBtn.addEventListener('click', () => {
    void scanEnvironment()
  })
  qsRequired(overlay, '#onboarding-skip').addEventListener('click', () => {
    dialogShell.close()
  })
  const closeBtn = qsRequired(overlay, '#onboarding-close')
  closeBtn.append(closeIcon('ui-icon'))
  closeBtn.addEventListener('click', () => {
    dialogShell.close()
  })

  // Every close funnels through the native event (Skip, ✕, Esc, and the finish
  // path): dismissal counts as completion so onboarding never shows twice.
  overlay.addEventListener('close', () => {
    if (!completed) void api.settings.set('onboardingCompleted', true)
    completed = false
    fallback?.lmStudio.destroy()
    fallback = null
    clear(fallbackPanel)
    fallbackPanel.hidden = true
    scanPanel.hidden = false
    mode = 'scan'
    findings = null
    scanPromise = null
    envScanBtn.disabled = false
    envStatusEl.textContent = ''
    envStatusEl.className = 'key-status'
  })

  overlay.addEventListener('onboarding-open', () => {
    finishBtn.textContent = 'Use these & finish'
    finishBtn.disabled = true
    clear(resultsEl)
    scanPromise = runScan()
  })
}
