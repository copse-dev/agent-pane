import type { ApiClient } from '../../../preload/api.d.ts'
import type { AcpAgentConfig, AcpAuthState } from '@shared/types/acp.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import {
  acpReauthCommand,
  KNOWN_ACP_AGENTS,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'
import { el, clear } from '../../dom/helpers.ts'
import { createAcpAgentsSection } from './acp-agents-section.ts'
import { AGENT_LOGO_SVG } from './agent-logos.ts'

// The "Coding agents" list in Settings: one row per agent that is on this
// device (or already added), with a Ready / Needs sign-in chip beside its name.
// Agents that are not installed live behind "+ Add an agent". Everything the old
// per-agent form offered (launch command, environment, model, permission mode,
// remove) stays reachable under a row's Options, rendered by the same
// acp-agents-section panel so the saved settings are unchanged.

export type AgentChip = 'ready' | 'needs-sign-in' | null

export interface AgentRowModel {
  id: string
  title: string
  chip: AgentChip
  /** Command to copy when the agent needs signing in. */
  signInCommand: string | null
}

/** What a row shows, from the device scan and the agent's own sign-in check. */
export function agentChip(auth: AcpAuthState | undefined): AgentChip {
  if (auth === 'signed-in') return 'ready'
  if (auth === 'signed-out') return 'needs-sign-in'
  // `unknown` is "could not tell", so it must not claim either state.
  return null
}

/**
 * Rows to list: known agents that are installed or already added, then any
 * custom agents the user added. Not-installed known agents go in the Add menu.
 */
export function listedAgents(
  known: readonly KnownAcpAgent[],
  detected: ReadonlyMap<string, DetectedAcpAgent>,
  configured: readonly AcpAgentConfig[],
  auth: ReadonlyMap<string, AcpAuthState>,
): AgentRowModel[] {
  const configuredIds = new Set(configured.map((a) => a.id))
  const rows: AgentRowModel[] = []
  for (const k of known) {
    if (!configuredIds.has(k.id) && !detected.get(k.id)?.installed) continue
    const chip = agentChip(auth.get(k.id))
    rows.push({
      id: k.id,
      title: k.title,
      chip,
      signInCommand: chip === 'needs-sign-in' ? acpReauthCommand(k) : null,
    })
  }
  const knownIds = new Set(known.map((k) => k.id))
  for (const a of configured) {
    if (knownIds.has(a.id)) continue
    rows.push({ id: a.id, title: a.title, chip: null, signInCommand: null })
  }
  return rows
}

/** Known agents that are neither installed nor added: the "+ Add an agent" menu. */
export function addableAgents(
  known: readonly KnownAcpAgent[],
  detected: ReadonlyMap<string, DetectedAcpAgent>,
  configured: readonly AcpAgentConfig[],
): KnownAcpAgent[] {
  const configuredIds = new Set(configured.map((a) => a.id))
  return known.filter((k) => !configuredIds.has(k.id) && !detected.get(k.id)?.installed)
}

const LOGO_KEY: Readonly<Record<string, string>> = {
  'claude-acp': 'claude',
  'claude-code-acp': 'claude',
  'codex-acp': 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
}

/** Brand tile for an agent; a letter tile when we have no mark for it. */
function logoTile(id: string, title: string): HTMLElement {
  const key = LOGO_KEY[id]
  const svg = key ? AGENT_LOGO_SVG[key] : undefined
  const tile = el('span', { class: 'acp-logo', 'aria-hidden': 'true' })
  if (key) tile.dataset['brand'] = key
  if (!svg) {
    tile.textContent = title.slice(0, 1).toUpperCase()
    return tile
  }
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  tile.append(document.importNode(doc.documentElement, true))
  return tile
}

const WATCH_INTERVAL_MS = 3000
const WATCH_MAX_TICKS = 40

export interface AcpAgentsList {
  root: HTMLElement
  refresh: () => Promise<void>
}

export interface AcpAgentsListOptions {
  /** Called after Re-scan imported API keys, so key status elsewhere can refresh. */
  onKeysImported?: () => void
}

export function createAcpAgentsList(
  api: ApiClient,
  opts: AcpAgentsListOptions = {},
): AcpAgentsList {
  let configured: AcpAgentConfig[] = []
  let detected = new Map<string, DetectedAcpAgent>()
  let auth = new Map<string, AcpAuthState>()
  let openId = ''
  let menuOpen = false
  let loaded = false
  // Auto-setup can install adapters, so it waits for the user to open an agent.
  let autoSetupRun = false

  const panel = createAcpAgentsSection(api, {
    embedded: true,
    onChanged: () => {
      render()
    },
  })
  const list = el('div', { class: 'acp-list', 'data-testid': 'acp-agents-list' })
  const addToggle = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary', 'data-testid': 'acp-add-toggle' },
    '+ Add an agent',
  )
  const menu = el('div', { class: 'acp-add-menu', 'data-testid': 'acp-add-menu' })
  addToggle.addEventListener('click', () => {
    menuOpen = !menuOpen
    if (menuOpen) openId = ''
    render()
  })
  const rescan = el('button', { type: 'button', class: 'acp-link' }, 'Re-scan')
  const scanStatus = el('span', {
    class: 'field-hint acp-scan-status',
    'data-testid': 'acp-scan-status',
  })
  rescan.addEventListener('click', () => void rescanAll())

  /**
   * Re-scan is the one explicit scan: it re-checks agents, then reads the
   * environment and shell start-up files for API keys and imports any that are
   * new. Clicking it is the opt-in the key scan requires, so the background
   * re-checks (focus, polling) never reach this path.
   */
  async function rescanAll(): Promise<void> {
    rescan.disabled = true
    scanStatus.textContent = 'Scanning…'
    try {
      await refresh()
      await api.settings.set('envKeyAutoDetectEnabled', true)
      const found = await api.settings.scanEnvKeys()
      const fresh = found.filter((key) => !key.alreadyConfigured)
      if (fresh.length === 0) {
        scanStatus.textContent = 'Up to date. Nothing new found.'
        return
      }
      const { imported } = await api.settings.importEnvKeys()
      scanStatus.textContent =
        imported.length === 0
          ? 'Nothing new to import.'
          : `Added ${String(imported.length)} key${imported.length === 1 ? '' : 's'} found on this Mac. Remove any you don’t want.`
      if (imported.length > 0) opts.onKeysImported?.()
    } catch (err) {
      scanStatus.textContent = err instanceof Error ? err.message : 'Scan failed'
    } finally {
      rescan.disabled = false
    }
  }

  const root = el(
    'fieldset',
    { 'data-testid': 'acp-agents-fieldset' },
    el('legend', {}, 'Coding agents'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Agents on this machine show up here on their own. Add another any time.',
    ),
    el('div', { class: 'acp-list-bar' }, scanStatus, rescan),
    list,
    el('div', { class: 'acp-add' }, addToggle, menu),
  )

  function chipEl(chip: AgentChip): Node[] {
    if (!chip) return []
    return [
      el(
        'span',
        { class: `acp-row-chip ${chip === 'ready' ? 'ok' : 'warn'}` },
        chip === 'ready' ? 'Ready' : 'Needs sign-in',
      ),
    ]
  }

  function row(model: AgentRowModel): HTMLElement {
    const open = openId === model.id
    const options = el(
      'button',
      { type: 'button', class: 'acp-link', 'aria-expanded': String(open) },
      open ? 'Hide options' : 'Options',
    )
    options.addEventListener('click', () => {
      openId = open ? '' : model.id
      menuOpen = false
      render()
      if (openId && !autoSetupRun) {
        autoSetupRun = true
        void panel.refresh().then(() => refresh())
      }
    })
    const action = model.signInCommand
      ? copyButton('Copy sign-in command', model.signInCommand, 'ui-btn ui-btn-primary')
      : options
    const head = el(
      'div',
      { class: 'acp-row-head' },
      logoTile(model.id, model.title),
      el(
        'div',
        { class: 'acp-row-text' },
        el('div', { class: 'acp-row-name' }, el('strong', {}, model.title), ...chipEl(model.chip)),
        el('div', { class: 'acp-row-desc' }, describe(model)),
      ),
      action,
    )
    const r = el('div', { class: 'acp-row', 'data-agent': model.id }, head)
    if (model.signInCommand) r.append(el('div', { class: 'acp-row-extra' }, options))
    if (open) {
      panel.select(model.id)
      r.append(el('div', { class: 'acp-row-options' }, panel.root))
    }
    return r
  }

  function describe(model: AgentRowModel): string {
    const known = KNOWN_ACP_AGENTS.find((k) => k.id === model.id)
    const path = detected.get(model.id)?.path
    if (path) return path
    return known ? `${known.title} on this machine.` : 'Custom agent.'
  }

  function copyButton(label: string, command: string, cls: string): HTMLButtonElement {
    const b = el('button', { type: 'button', class: cls, title: command }, label)
    b.addEventListener('click', () => {
      void navigator.clipboard.writeText(command)
      b.textContent = 'Copied'
      watchForChanges()
    })
    return b
  }

  function addRow(known: KnownAcpAgent): HTMLElement {
    const install = known.install
    const action = install
      ? copyButton('Copy install command', install, 'ui-btn ui-btn-secondary')
      : el('span', { class: 'acp-row-desc' }, 'Not available')
    return el(
      'div',
      { class: 'acp-row acp-add-row', 'data-agent': known.id },
      el(
        'div',
        { class: 'acp-row-head' },
        logoTile(known.id, known.title),
        el(
          'div',
          { class: 'acp-row-text' },
          el('div', { class: 'acp-row-name' }, el('strong', {}, known.title)),
          el(
            'div',
            { class: 'acp-row-desc' },
            'Run the install command in a terminal, then Re-scan.',
          ),
        ),
        action,
      ),
    )
  }

  function render(): void {
    clear(list)
    const rows = listedAgents(KNOWN_ACP_AGENTS, detected, configured, auth)
    for (const model of rows) list.append(row(model))
    if (!rows.length) {
      list.append(
        el(
          'div',
          { class: 'acp-empty' },
          loaded ? 'No agents on this machine yet. Add one below.' : 'Looking for agents…',
        ),
      )
    }
    clear(menu)
    menu.hidden = !menuOpen
    addToggle.setAttribute('aria-expanded', String(menuOpen))
    if (!menuOpen) return
    for (const known of addableAgents(KNOWN_ACP_AGENTS, detected, configured)) {
      menu.append(addRow(known))
    }
    const custom = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Set up')
    custom.addEventListener('click', () => {
      panel.select('other')
      clear(menu)
      menu.append(panel.root)
    })
    menu.append(
      el(
        'div',
        { class: 'acp-row acp-add-row', 'data-agent': 'other' },
        el(
          'div',
          { class: 'acp-row-head' },
          logoTile('other', '+'),
          el(
            'div',
            { class: 'acp-row-text' },
            el('div', { class: 'acp-row-name' }, el('strong', {}, 'Something else')),
            el('div', { class: 'acp-row-desc' }, 'Any agent program on this machine.'),
          ),
          custom,
        ),
      ),
    )
  }

  /** Device scan + sign-in check, without repainting. */
  async function scanDevice(): Promise<void> {
    try {
      const found = await api.acp.detectAgents()
      detected = new Map(found.map((d) => [d.id, d]))
    } catch {
      detected = new Map()
    }
    const ids = KNOWN_ACP_AGENTS.filter((k) => detected.get(k.id)?.installed).map((k) => k.id)
    try {
      const statuses = ids.length ? await api.acp.authStatus(ids) : []
      auth = new Map(statuses.map((s) => [s.id, s.state]))
    } catch {
      auth = new Map()
    }
  }

  function signature(): string {
    return JSON.stringify([
      [...detected.values()].map((d) => [d.id, d.installed]),
      [...auth.entries()],
    ])
  }

  async function refresh(): Promise<void> {
    try {
      configured = parseAcpAgentConfigs(await api.settings.get('registeredAcpAgents'))
    } catch {
      configured = []
    }
    await scanDevice()
    loaded = true
    render()
    void panel.reload()
  }

  /**
   * Re-scan quietly and repaint only when something changed, so a copied
   * command's "Copied" label and an open Options form are not disturbed.
   */
  async function quietRescan(): Promise<void> {
    const before = signature()
    await scanDevice()
    if (signature() !== before) render()
  }

  // After the user copies an install or sign-in command, notice when they have
  // run it: poll briefly, and also re-check whenever the window regains focus.
  let watchTimer: ReturnType<typeof setInterval> | undefined
  function watchForChanges(): void {
    if (watchTimer) clearInterval(watchTimer)
    let ticks = 0
    watchTimer = setInterval(() => {
      ticks += 1
      if (!root.isConnected || ticks > WATCH_MAX_TICKS) {
        clearInterval(watchTimer)
        watchTimer = undefined
        return
      }
      void quietRescan()
    }, WATCH_INTERVAL_MS)
  }
  const onFocus = (): void => {
    // The dialog is rebuilt on every open; a listener for a gone dialog retires itself.
    if (!root.isConnected) {
      window.removeEventListener('focus', onFocus)
      return
    }
    if (loaded) void quietRescan()
  }
  window.addEventListener('focus', onFocus)

  return { root, refresh }
}
