import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { AcpAgentConfig, AcpAuthState } from '@shared/types/acp.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import {
  KNOWN_ACP_AGENTS,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'
import { el, clear } from '../../dom/helpers.ts'
import { ipcErrorMessage } from '../../ipc-error-message.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import { addableAgents, listedAgents, logoTile, type AgentRowModel } from './acp-agents-list.ts'
import { createAcpAgentsSection } from './acp-agents-section.ts'
import { AGENT_LOGO_SVG } from './agent-logos.ts'
import { createChatGptPlanSection } from './chatgpt-plan-section.ts'
import { createCustomProvidersSection, type NativeProvider } from './custom-providers-section.ts'
import { detectLocalServers, localServerTargets } from './local-detection.ts'
import { createOpenAiServiceTierField } from './openai-service-tier-field.ts'
import { createPasteKeyForm } from './paste-key-form.ts'

// The one "Models & agents" list in Settings > General: everything Copse can
// run a turn on, as rows. A ChatGPT plan, coding agents on this machine, API
// keys and model servers each get a row with a status chip, grouped by company
// (OpenAI, Anthropic, Google, Cursor, then everything else). One "+ Add" menu
// installs an agent, pastes a key, connects a model server or sets up a custom
// agent; one "Re-scan" re-checks all of them. Each row's Options renders the
// same per-provider forms the old separate panels used (custom-providers-section
// for keys and servers, acp-agents-section for agents), so stored settings and
// their validation are unchanged. Prototype: prototypes/connections-combined.html.

/** A cloud agent offered by an API-key provider, built by the host. */
export interface CloudAgentPanel {
  /** Key provider whose Options show this cloud agent (`anthropic`, `cursor`). */
  provider: string
  /** Authentication + guidance element. */
  element: HTMLElement
}

export type ConnectionRow =
  | { kind: 'plan'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'key'; id: string }
  | { kind: 'server'; id: string }

interface Family {
  plan?: string
  agents: readonly string[]
  key: string
}

// A company's connections sit together: its plan, its agents, then its key.
const FAMILIES: readonly Family[] = [
  { plan: 'chatgpt', agents: ['codex-acp'], key: 'openai' },
  { agents: ['claude-acp', 'claude-code-acp'], key: 'anthropic' },
  { agents: ['gemini'], key: 'gemini' },
  { agents: ['cursor'], key: 'cursor' },
]

/**
 * Row order: each company's plan, agents and key together, then other agents,
 * other keys, and model servers last. Plans always show (they are how you sign
 * in); agents, keys and servers only once they are on this machine or saved.
 */
export function connectionRows(
  agents: readonly string[],
  keys: readonly string[],
  servers: readonly string[],
): ConnectionRow[] {
  const rows: ConnectionRow[] = []
  const agentSet = new Set(agents)
  const keySet = new Set(keys)
  for (const family of FAMILIES) {
    if (family.plan) rows.push({ kind: 'plan', id: family.plan })
    for (const id of family.agents) if (agentSet.has(id)) rows.push({ kind: 'agent', id })
    if (keySet.has(family.key)) rows.push({ kind: 'key', id: family.key })
  }
  const familyAgents = new Set(FAMILIES.flatMap((family) => family.agents))
  const familyKeys = new Set(FAMILIES.map((family) => family.key))
  for (const id of agents) if (!familyAgents.has(id)) rows.push({ kind: 'agent', id })
  for (const id of keys) if (!familyKeys.has(id)) rows.push({ kind: 'key', id })
  for (const id of servers) rows.push({ kind: 'server', id })
  return rows
}

/** Key providers outside the generic key panel that still take a pasted key. */
const OTHER_KEY_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
]

const WATCH_INTERVAL_MS = 3000
const WATCH_MAX_TICKS = 40

type AddForm = '' | 'key' | 'server' | 'agent'

export interface ModelsAgentsListOptions {
  /** LM Studio and any other model server with its own bespoke form. */
  nativeLocalProviders?: readonly NativeProvider[]
  /** Cloud agents shown under their provider key's Options. */
  cloudAgents?: readonly CloudAgentPanel[]
  /**
   * Run options shared by every cloud agent. They carry named form controls, so
   * they always stay inside the host form: shown with an open cloud agent and
   * parked (hidden) in the list otherwise.
   */
  cloudAgentOptions?: HTMLElement
  /**
   * Open a fresh terminal running an install or sign-in command the user chose.
   * Without it the list offers to copy the command instead.
   */
  runInTerminal?: (command: string) => void
  /** Called after keys were saved, imported or removed. */
  onKeysChanged?: () => void
}

export interface ModelsAgentsList {
  root: HTMLElement
  refresh: (snapshot?: SettingsSnapshot, signal?: AbortSignal) => Promise<void>
  reset: () => void
  readUpdate: () => SettingsUpdate
  /** Persist keys typed into key or server Options. False keeps the dialog open. */
  saveKeys: () => Promise<boolean>
}

export function createModelsAgentsList(
  api: ApiClient,
  opts: ModelsAgentsListOptions = {},
): ModelsAgentsList {
  let configured: AcpAgentConfig[] = []
  let detected = new Map<string, DetectedAcpAgent>()
  let auth = new Map<string, AcpAuthState>()
  /** Providers with a key stored in Settings. */
  const storedKeys = new Set<string>()
  /** At-rest encryption per stored key: true = OS keychain, false = plaintext. */
  const encrypted = new Map<string, boolean>()
  let running = new Set<string>()
  let openId = ''
  let menuOpen = false
  let addForm: AddForm = ''
  let agentSetupId = ''
  let serverChoice = ''
  let loaded = false
  let activeSignal: AbortSignal | undefined
  let generation = 0
  // Auto-setup can install adapters, so it waits for the user to open an agent.
  let autoSetupRun = false
  const launched = new Set<string>()

  const repaint = (): void => {
    if (loaded && !activeSignal?.aborted) render()
  }

  const agentsPanel = createAcpAgentsSection(api, {
    embedded: true,
    onChanged: () => {
      void api.settings
        .get('registeredAcpAgents')
        .then((value) => {
          const previousIds = new Set(configured.map((agent) => agent.id))
          configured = parseAcpAgentConfigs(value)
          const added = configured.find((agent) => !previousIds.has(agent.id))
          if (added && menuOpen) {
            openId = `agent:${added.id}`
            closeMenu()
          }
          repaint()
        })
        .catch(() => {})
    },
  })
  const keysPanel = createCustomProvidersSection(api, {
    variant: 'cloud',
    deferOrdinaryWrites: true,
    embedded: true,
    onChanged: repaint,
  })
  const serversPanel = createCustomProvidersSection(api, {
    variant: 'local',
    deferOrdinaryWrites: true,
    embedded: true,
    onChanged: repaint,
    ...(opts.nativeLocalProviders ? { nativeProviders: opts.nativeLocalProviders } : {}),
  })
  const chatGptPlan = createChatGptPlanSection(api, repaint)
  // The plan section's own refresh can show its one-time welcome, so it runs
  // only once the user opens the ChatGPT row; until then the chip reads the
  // plain status.
  let planReady = false
  let planOpened = false
  const tier = createOpenAiServiceTierField(api)

  function keyChoices(): { id: string; label: string }[] {
    return [
      ...keysPanel.providerIds().map((id) => ({ id, label: keysPanel.labelFor(id) ?? id })),
      ...OTHER_KEY_PROVIDERS,
    ]
  }

  const pasteKey = createPasteKeyForm(api, {
    providers: keyChoices,
    onSaved: () => {
      void refreshKeys().then(() => opts.onKeysChanged?.())
    },
    renderOther: () => {
      keysPanel.select('other')
      return keysPanel.root
    },
  })

  const cloudByProvider = new Map((opts.cloudAgents ?? []).map((c) => [c.provider, c]))
  // Cloud-agent elements return to wherever the host built them (a hidden part
  // of its form) whenever no row shows them, so their fields keep round-tripping.
  const parking = el('div', { hidden: true })
  const homes = new Map<HTMLElement, HTMLElement>()
  for (const element of [
    ...(opts.cloudAgents ?? []).map((c) => c.element),
    ...(opts.cloudAgentOptions ? [opts.cloudAgentOptions] : []),
  ]) {
    homes.set(element, element.parentElement ?? parking)
  }
  function park(): void {
    for (const [element, home] of homes) home.append(element)
    if (opts.cloudAgentOptions) opts.cloudAgentOptions.hidden = true
  }

  const list = el('div', { class: 'acp-list', 'data-testid': 'models-agents-list' })
  const addToggle = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-secondary',
      'data-testid': 'connections-add-toggle',
      'aria-expanded': 'false',
    },
    '+ Add',
  )
  const menu = el('div', { class: 'acp-add-menu', 'data-testid': 'connections-add-menu' })
  menu.hidden = true
  addToggle.addEventListener('click', () => {
    menuOpen = !menuOpen
    addForm = ''
    agentSetupId = ''
    if (menuOpen) openId = ''
    render()
  })
  const rescan = el(
    'button',
    { type: 'button', class: 'acp-link', 'data-testid': 'connections-rescan' },
    'Re-scan',
  )
  const scanStatus = el('span', {
    class: 'field-hint acp-scan-status',
    'data-testid': 'connections-scan-status',
    role: 'status',
  })
  rescan.addEventListener('click', () => void rescanAll())

  const root = el(
    'fieldset',
    { 'data-testid': 'models-agents-fieldset' },
    el('legend', {}, 'Models & agents'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Everything Copse can run a turn on. A ChatGPT plan, a coding agent and an API key are separate connections, so use any of them, or all. Agents and model servers on this machine show up on their own. Re-scan also reads API keys from your environment and shell startup files and imports new ones; existing keys are never overwritten.',
    ),
    el('div', { class: 'acp-list-bar' }, scanStatus, rescan),
    list,
    el('div', { class: 'acp-add' }, addToggle, menu),
    parking,
  )

  function closeMenu(): void {
    menuOpen = false
    addForm = ''
    agentSetupId = ''
  }

  /**
   * Re-scan is the one explicit scan: it re-checks agents and model servers,
   * then reads the environment and shell start-up files for API keys and imports
   * any that are new. Clicking it is the opt-in the key scan requires, so the
   * background re-checks (focus, polling) never reach this path.
   */
  async function rescanAll(): Promise<void> {
    rescan.disabled = true
    scanStatus.textContent = 'Scanning…'
    try {
      const pending = refresh(undefined, activeSignal)
      const mine = generation
      await pending
      if (mine !== generation || activeSignal?.aborted || !loaded) return
      await api.settings.set('envKeyAutoDetectEnabled', true)
      if (mine !== generation || activeSignal?.aborted) return
      const found = await api.settings.scanEnvKeys()
      if (mine !== generation || activeSignal?.aborted) return
      const fresh = found.filter((key) => !key.alreadyConfigured)
      if (fresh.length === 0) {
        scanStatus.textContent = 'Up to date. Nothing new found.'
        return
      }
      const { imported, skipped } = await api.settings.importEnvKeys(
        fresh.map((key) => key.provider),
      )
      if (mine !== generation || activeSignal?.aborted) return
      scanStatus.textContent =
        imported.length === 0
          ? 'Nothing new to import.'
          : `Added ${String(imported.length)} key${imported.length === 1 ? '' : 's'} found on this machine. Remove any you don’t want.`
      if (skipped.length > 0)
        scanStatus.textContent += ` ${String(skipped.length)} keys could not be imported. Review secure storage settings.`
      if (imported.length > 0) {
        await refreshKeys()
        opts.onKeysChanged?.()
      }
    } catch (err) {
      scanStatus.textContent = ipcErrorMessage(err, 'Scan failed. Please try again.')
    } finally {
      rescan.disabled = false
    }
  }

  // ---- Rows ----------------------------------------------------------------

  function chip(text: string, tone: 'ok' | 'warn' | ''): HTMLElement {
    return el('span', { class: `acp-row-chip${tone ? ` ${tone}` : ''}` }, text)
  }

  function optionsButton(id: string, label = 'Options'): HTMLButtonElement {
    const open = openId === id
    const button = el(
      'button',
      { type: 'button', class: 'acp-link', 'aria-expanded': String(open) },
      open ? 'Hide options' : label,
    )
    button.addEventListener('click', () => {
      openId = open ? '' : id
      closeMenu()
      render()
    })
    return button
  }

  function row(
    rowId: string,
    tile: HTMLElement,
    title: string,
    chips: HTMLElement[],
    desc: string,
    actions: HTMLElement[],
    options: () => HTMLElement[],
  ): HTMLElement {
    const head = el(
      'div',
      { class: 'acp-row-head' },
      tile,
      el(
        'div',
        { class: 'acp-row-text' },
        el('div', { class: 'acp-row-name' }, el('strong', {}, title), ...chips),
        el('div', { class: 'acp-row-desc' }, desc),
      ),
      ...actions,
    )
    const r = el('div', { class: 'acp-row', 'data-row': rowId }, head)
    if (openId === rowId) r.append(el('div', { class: 'acp-row-options' }, ...options()))
    return r
  }

  /** A command the user runs: in a terminal when the host has one, else copied. */
  function commandButton(
    label: string,
    pendingLabel: string,
    command: string,
    cls: string,
  ): HTMLButtonElement {
    const b = el('button', { type: 'button', class: cls, title: command }, label)
    if (launched.has(command)) b.textContent = opts.runInTerminal ? pendingLabel : 'Copied'
    b.addEventListener('click', () => {
      launched.add(command)
      if (opts.runInTerminal) {
        b.textContent = pendingLabel
        opts.runInTerminal(command)
      } else {
        void navigator.clipboard.writeText(command)
        b.textContent = 'Copied'
      }
      watchForChanges()
    })
    return b
  }

  function agentRow(model: AgentRowModel): HTMLElement {
    const rowId = `agent:${model.id}`
    const options = optionsButton(rowId)
    options.addEventListener('click', () => {
      if (
        openId === rowId &&
        !autoSetupRun &&
        KNOWN_ACP_AGENTS.some((agent) => agent.id === model.id)
      ) {
        autoSetupRun = true
        void agentsPanel.refresh().then(() => refresh(undefined, activeSignal))
      }
    })
    const actions: HTMLElement[] = []
    if (model.signInCommand) {
      actions.push(
        commandButton(
          opts.runInTerminal ? 'Sign in' : 'Copy sign-in command',
          'Opened in a terminal…',
          model.signInCommand,
          'ui-btn ui-btn-primary',
        ),
      )
    }
    actions.push(options)
    const known = KNOWN_ACP_AGENTS.find((k) => k.id === model.id)
    const chips =
      model.chip === 'ready'
        ? [chip('Ready', 'ok')]
        : model.chip === 'needs-sign-in'
          ? [chip('Needs sign-in', 'warn')]
          : []
    const r = row(
      rowId,
      logoTile(model.id, model.title),
      model.title,
      chips,
      detected.get(model.id)?.path ?? (known ? `${known.title} on this machine.` : 'Custom agent.'),
      actions,
      () => {
        agentsPanel.select(model.id)
        return [agentsPanel.root]
      },
    )
    r.dataset['agent'] = model.id
    return r
  }

  function planRow(): HTMLElement {
    const rowId = 'plan:chatgpt'
    const ready = planOpened ? chatGptPlan.configured() : planReady
    const tile = el('span', { class: 'acp-logo', 'data-brand': 'chatgpt', 'aria-hidden': 'true' })
    tile.append(el('img', { src: './chatgpt-logo-white.svg', alt: '', width: '20', height: '20' }))
    const options = optionsButton(rowId, ready ? 'Options' : 'Sign in')
    options.addEventListener('click', () => {
      if (openId !== rowId || planOpened) return
      planOpened = true
      void chatGptPlan.refresh()
    })
    return row(
      rowId,
      tile,
      'ChatGPT',
      ready ? [chip('Ready', 'ok')] : [],
      'Copse’s own agent and tools, using your ChatGPT plan or available credits.',
      [options],
      () => [chatGptPlan.root],
    )
  }

  function keyLabel(id: string): string {
    return (
      keysPanel.labelFor(id) ?? OTHER_KEY_PROVIDERS.find((entry) => entry.id === id)?.label ?? id
    )
  }

  function keyTile(): HTMLElement {
    const tile = el('span', { class: 'acp-logo', 'data-brand': 'key', 'aria-hidden': 'true' })
    const glyph = AGENT_LOGO_SVG['key']
    if (glyph) {
      const doc = new DOMParser().parseFromString(glyph, 'image/svg+xml')
      tile.append(document.importNode(doc.documentElement, true))
    }
    return tile
  }

  function hasStoredKey(id: string): boolean {
    return storedKeys.has(id)
  }

  function cloudBlock(cloud: CloudAgentPanel): HTMLElement {
    const block = el(
      'div',
      { class: 'provider-capability' },
      el('h4', { class: 'provider-capability-title' }, 'Cloud agent'),
      cloud.element,
    )
    if (opts.cloudAgentOptions) {
      opts.cloudAgentOptions.hidden = false
      block.append(opts.cloudAgentOptions)
    }
    return block
  }

  function keyOptions(id: string): HTMLElement[] {
    const parts: HTMLElement[] = []
    if (keysPanel.labelFor(id) !== null) {
      keysPanel.select(id)
      parts.push(keysPanel.root)
    }
    if (id === 'openai') parts.push(tier.element())
    const cloud = cloudByProvider.get(id)
    if (cloud) parts.push(cloudBlock(cloud))
    return parts
  }

  async function removeKey(id: string): Promise<void> {
    const label = keyLabel(id)
    const approved = await showConfirmDialog({
      message: `Remove the ${label} API key from Copse?`,
      detail:
        'Its models leave the model picker. If the key is also in your environment or shell startup files, Re-scan imports it again.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!approved) return
    try {
      await api.settings.setKey(id, '')
      if (openId === `key:${id}`) openId = ''
      await refreshKeys()
      opts.onKeysChanged?.()
    } catch (err) {
      scanStatus.textContent = ipcErrorMessage(err, `Could not remove the ${label} key.`)
    }
  }

  function keyRow(id: string): HTMLElement {
    const rowId = `key:${id}`
    const stored = hasStoredKey(id)
    const atRest = encrypted.get(id)
    const storage = !stored
      ? 'Custom endpoint · no key saved'
      : atRest === undefined
        ? 'Pay per use'
        : atRest
          ? 'Pay per use · encrypted by your system keychain'
          : 'Pay per use · stored unencrypted on this machine'
    const actions: HTMLElement[] = [optionsButton(rowId)]
    if (stored) {
      const remove = el('button', { type: 'button', class: 'acp-link' }, 'Remove')
      remove.addEventListener('click', () => void removeKey(id))
      actions.push(remove)
    }
    const r = row(
      rowId,
      keyTile(),
      `${keyLabel(id)} API key`,
      stored ? [chip('Saved', 'ok')] : [chip('Custom', '')],
      storage,
      actions,
      () => keyOptions(id),
    )
    r.dataset['key'] = id
    return r
  }

  function serverRow(id: string): HTMLElement {
    const rowId = `server:${id}`
    const label = serversPanel.labelFor(id) ?? id
    const target = localServerTargets().find((t) => t.id === id)
    const r = row(
      rowId,
      logoTile(id, label),
      label,
      running.has(id) ? [chip('Running', 'ok')] : [chip('Added', '')],
      target ? `Model server on this machine · ${target.baseUrl}` : 'Model server you added.',
      [optionsButton(rowId)],
      () => {
        serversPanel.select(id)
        return [serversPanel.root]
      },
    )
    r.dataset['server'] = id
    return r
  }

  // ---- Add menu --------------------------------------------------------------

  function menuGroup(text: string): HTMLElement {
    return el('div', { class: 'connections-menu-group' }, text)
  }

  function menuRow(
    id: string,
    tile: HTMLElement,
    title: string,
    desc: string | Node,
    actions: HTMLElement[],
    body?: HTMLElement,
  ): HTMLElement {
    return el(
      'div',
      { class: 'acp-row acp-add-row', 'data-add': id },
      el(
        'div',
        { class: 'acp-row-head' },
        tile,
        el(
          'div',
          { class: 'acp-row-text' },
          el('div', { class: 'acp-row-name' }, el('strong', {}, title)),
          el('div', { class: 'acp-row-desc' }, desc),
        ),
        ...actions,
      ),
      ...(body ? [el('div', { class: 'acp-row-options' }, body)] : []),
    )
  }

  function addFormButton(form: AddForm, label: string): HTMLButtonElement[] {
    if (addForm === form) {
      const cancel = el('button', { type: 'button', class: 'acp-link' }, 'Cancel')
      cancel.addEventListener('click', () => {
        addForm = ''
        agentSetupId = ''
        render()
      })
      return [cancel]
    }
    const b = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, label)
    b.addEventListener('click', () => {
      addForm = form
      agentSetupId = form === 'agent' ? 'other' : ''
      if (form === 'key') pasteKey.refreshChoices()
      render()
    })
    return [b]
  }

  function agentAddRow(known: KnownAcpAgent): HTMLElement {
    const actions: HTMLElement[] = []
    if (known.install) {
      actions.push(
        commandButton(
          opts.runInTerminal ? 'Install' : 'Copy install command',
          'Installing in a terminal…',
          known.install,
          'ui-btn ui-btn-secondary',
        ),
      )
    }
    const setup = el('button', { type: 'button', class: 'acp-link' }, 'Set up')
    setup.addEventListener('click', () => {
      addForm = 'agent'
      agentSetupId = known.id
      render()
    })
    actions.push(setup)
    const desc = known.install
      ? el(
          'span',
          {},
          opts.runInTerminal
            ? 'Installs in a terminal with '
            : 'Run this in a terminal, then Re-scan: ',
          el('code', {}, known.install),
        )
      : 'Set it up by hand.'
    const r = menuRow(
      `agent:${known.id}`,
      logoTile(known.id, known.title),
      known.title,
      desc,
      actions,
      addForm === 'agent' && agentSetupId === known.id ? setupAgentBody(known.id) : undefined,
    )
    r.dataset['agent'] = known.id
    return r
  }

  function setupAgentBody(id: string): HTMLElement {
    agentsPanel.select(id)
    return agentsPanel.root
  }

  /** Model servers not already listed, then a custom URL. */
  function serverChoices(listed: ReadonlySet<string>): { id: string; label: string }[] {
    return serversPanel
      .providerIds()
      .filter((id) => !listed.has(id))
      .map((id) => ({ id, label: serversPanel.labelFor(id) ?? id }))
  }

  function serverAddBody(listed: ReadonlySet<string>): HTMLElement {
    const choices = serverChoices(listed)
    const picker = el('select', { 'data-testid': 'connections-server-choice' })
    for (const choice of choices) picker.append(el('option', { value: choice.id }, choice.label))
    picker.append(el('option', { value: 'other' }, 'Other (custom URL)…'))
    if (![...choices.map((c) => c.id), 'other'].includes(serverChoice)) {
      serverChoice = choices[0]?.id ?? 'other'
    }
    picker.value = serverChoice
    picker.addEventListener('change', () => {
      serverChoice = picker.value
      render()
    })
    serversPanel.select(serverChoice)
    return el(
      'div',
      { class: 'connections-add-form' },
      el('label', {}, 'Which server?', picker),
      el(
        'p',
        { class: 'field-hint' },
        'Most need no key. Set its address, fetch its models, then save; they appear in the model picker.',
      ),
      serversPanel.root,
    )
  }

  function renderMenu(listedServers: ReadonlySet<string>): void {
    clear(menu)
    menu.hidden = !menuOpen
    addToggle.setAttribute('aria-expanded', String(menuOpen))
    if (!menuOpen) return
    const addable = addableAgents(KNOWN_ACP_AGENTS, detected, configured)
    if (addable.length) {
      menu.append(menuGroup('Coding agents on this machine'))
      for (const known of addable) menu.append(agentAddRow(known))
    }
    menu.append(menuGroup('Other connections'))
    menu.append(
      menuRow(
        'key',
        keyTile(),
        'API key',
        'Pay per use, for any provider. Paste one and Copse suggests which.',
        addFormButton('key', 'Add key'),
        addForm === 'key' ? pasteKey.root : undefined,
      ),
      menuRow(
        'server',
        logoTile('server', 'S'),
        'Model server on this machine',
        'Ollama, LM Studio, llama.cpp, Jan, vLLM or any OpenAI-compatible URL. Running ones show up on their own.',
        addFormButton('server', 'Connect'),
        addForm === 'server' ? serverAddBody(listedServers) : undefined,
      ),
      menuRow(
        'agent',
        logoTile('other', '+'),
        'Custom agent',
        'Any agent program on this machine, or one from the agent registry.',
        addFormButton('agent', 'Set up'),
        addForm === 'agent' && agentSetupId === 'other' ? setupAgentBody('other') : undefined,
      ),
    )
  }

  function keyIds(): string[] {
    return [
      ...keysPanel.providerIds().filter((id) => keysPanel.isConfigured(id)),
      ...OTHER_KEY_PROVIDERS.map((entry) => entry.id).filter((id) => storedKeys.has(id)),
    ]
  }

  function serverIds(): string[] {
    return serversPanel
      .providerIds()
      .filter((id) => running.has(id) || serversPanel.isConfigured(id))
  }

  function render(): void {
    // Detaching an open row must never take the cloud-agent fields out of the form.
    park()
    clear(list)
    if (!loaded) {
      list.append(el('div', { class: 'acp-empty' }, 'Looking for models and agents…'))
      renderMenu(new Set())
      return
    }
    const agents = listedAgents(KNOWN_ACP_AGENTS, detected, configured, auth)
    const agentById = new Map(agents.map((model) => [model.id, model]))
    const servers = serverIds()
    for (const entry of connectionRows(
      agents.map((model) => model.id),
      keyIds(),
      servers,
    )) {
      if (entry.kind === 'plan') list.append(planRow())
      else if (entry.kind === 'key') list.append(keyRow(entry.id))
      else if (entry.kind === 'server') list.append(serverRow(entry.id))
      else {
        const model = agentById.get(entry.id)
        if (model) list.append(agentRow(model))
      }
    }
    renderMenu(new Set(servers))
  }

  // ---- Data ------------------------------------------------------------------

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

  /** Saved-key status: the key panel's own, plus Cursor and at-rest encryption. */
  async function readKeyStatus(): Promise<void> {
    const ids = [...keysPanel.providerIds(), ...OTHER_KEY_PROVIDERS.map((entry) => entry.id)]
    const results = await Promise.all(
      ids.map(async (id): Promise<{ id: string; stored: boolean; atRest: boolean | null }> => {
        try {
          const [stored, atRest] = await Promise.all([
            api.settings.getKey(id),
            api.settings.getKeyEncrypted(id),
          ])
          return { id, stored, atRest }
        } catch {
          return { id, stored: false, atRest: null }
        }
      }),
    )
    storedKeys.clear()
    encrypted.clear()
    for (const { id, stored, atRest } of results) {
      if (!stored) continue
      storedKeys.add(id)
      if (atRest !== null) encrypted.set(id, atRest)
    }
  }

  async function readPlanStatus(): Promise<void> {
    try {
      const status = await api.chatGptPlan.status()
      planReady = status.accounts.some((account) => account.planEnabled && account.connected)
    } catch {
      planReady = false
    }
  }

  async function refreshKeys(): Promise<void> {
    const mine = generation
    await keysPanel.refresh(undefined, activeSignal)
    await readKeyStatus()
    pasteKey.refreshChoices()
    if (mine === generation) repaint()
  }

  /**
   * Probe local model servers without blocking the list: a dead port can take a
   * while to time out. LM Studio is probed at its saved address. Read-only.
   */
  async function probeServers(): Promise<void> {
    const mine = generation
    let lmStudioUrl = ''
    try {
      const saved = await api.settings.get('localServerUrl')
      lmStudioUrl = typeof saved === 'string' ? saved.trim() : ''
    } catch {
      /* the default address still gets probed */
    }
    const targets = localServerTargets().map((target) =>
      target.id === 'lmstudio' && lmStudioUrl ? { ...target, baseUrl: lmStudioUrl } : target,
    )
    const results = await detectLocalServers(api, targets)
    if (mine !== generation || activeSignal?.aborted) return
    const next = new Set(results.filter((r) => r.reachable).map((r) => r.id))
    const changed = [...next].join() !== [...running].join()
    running = next
    // An open form keeps its edits; the next repaint picks the change up.
    if (changed && !openId && !addForm) repaint()
  }

  async function refresh(snapshot?: SettingsSnapshot, signal?: AbortSignal): Promise<void> {
    activeSignal = signal
    const mine = ++generation
    if (signal?.aborted) return
    try {
      configured = parseAcpAgentConfigs(await api.settings.get('registeredAcpAgents'))
    } catch {
      configured = []
    }
    await Promise.all([
      scanDevice(),
      keysPanel.refresh(snapshot, signal),
      serversPanel.refresh(snapshot, signal),
      tier.refresh(snapshot, signal),
      readPlanStatus(),
    ])
    if (signal?.aborted || mine !== generation) return
    await readKeyStatus()
    if (signal?.aborted || mine !== generation) return
    loaded = true
    await agentsPanel.reload(signal)
    if (signal?.aborted || mine !== generation) return
    pasteKey.refreshChoices()
    render()
    void probeServers()
  }

  function signature(): string {
    return JSON.stringify([
      [...detected.values()].map((d) => [d.id, d.installed]),
      [...auth.entries()],
    ])
  }

  /**
   * Re-scan agents quietly and repaint only when something changed, so a
   * launched command's label and an open Options form are not disturbed.
   */
  let quietScanRunning = false
  async function quietRescan(): Promise<void> {
    if (activeSignal?.aborted || !loaded || quietScanRunning) return
    quietScanRunning = true
    try {
      const mine = generation
      const before = signature()
      await scanDevice()
      if (
        !activeSignal?.aborted &&
        mine === generation &&
        signature() !== before &&
        !openId &&
        !menuOpen
      )
        render()
    } finally {
      quietScanRunning = false
    }
  }

  // After the user runs an install or sign-in command, notice when it is done:
  // poll briefly, and also re-check whenever the window regains focus.
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
    // The mounted dialog is reused; reset stops probing while it is closed.
    if (!root.isConnected) {
      window.removeEventListener('focus', onFocus)
      return
    }
    if (loaded) void quietRescan()
  }
  window.addEventListener('focus', onFocus)

  function reset(): void {
    generation += 1
    activeSignal = undefined
    loaded = false
    openId = ''
    closeMenu()
    serverChoice = ''
    autoSetupRun = false
    planOpened = false
    launched.clear()
    if (watchTimer) clearInterval(watchTimer)
    watchTimer = undefined
    agentsPanel.select('')
    pasteKey.reset()
    keysPanel.reset()
    serversPanel.reset()
    tier.reset()
    scanStatus.textContent = ''
    render()
  }

  render()
  return {
    root,
    refresh,
    reset,
    readUpdate: () => ({
      ...keysPanel.readUpdate(),
      ...serversPanel.readUpdate(),
      ...tier.readUpdate(),
    }),
    saveKeys: async (): Promise<boolean> => {
      const [keysSaved, serversSaved] = await Promise.all([
        keysPanel.saveKeys(),
        serversPanel.saveKeys(),
      ])
      return keysSaved && serversSaved
    },
  }
}
