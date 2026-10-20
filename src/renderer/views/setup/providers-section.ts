import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { el, clear } from '../../dom/helpers.ts'
import { createCustomProvidersSection, type NativeProvider } from './custom-providers-section.ts'
import { createAcpAgentsSection } from './acp-agents-section.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { createChatGptPlanSection } from './chatgpt-plan-section.ts'
import { createPasteKeyForm } from './paste-key-form.ts'

// The onboarding fallback's "Providers" panel. A provider is a company, not a
// wiring mechanism: picking Anthropic shows its API key and the Claude agent on
// this device. Settings uses the combined Models & agents list instead
// (models-agents-list.ts).
//
// Under the hood that is three separate panels — cloud API keys, local servers
// and device agents. This module owns a single chip row across all of them and
// shows only the blocks the selected provider actually offers.

/** A provider chip and the capabilities folded under it. */
interface VendorSpec {
  id: string
  label: string
  /** Cloud API-key provider ids shown under this chip. */
  api?: readonly string[]
  /** Local-server provider ids shown under this chip. */
  local?: readonly string[]
  /** Device-agent ids shown under this chip. */
  agents?: readonly string[]
}

// Providers whose capabilities span more than one panel, so a single chip has to
// gather them. Everything else gets a chip of its own, in its panel's order.
const MERGED_VENDORS: readonly VendorSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: ['anthropic'],
    agents: ['claude-acp'],
  },
  { id: 'openai', label: 'OpenAI', api: ['openai'], agents: ['codex-acp'] },
  { id: 'cursor', label: 'Cursor', agents: ['cursor'] },
  { id: 'gemini', label: 'Google Gemini', api: ['gemini'], agents: ['gemini'] },
]

const ADD_KEY = 'other'

type AddKind = 'api' | 'local' | 'agent'

const ADD_KINDS: readonly { kind: AddKind; label: string }[] = [
  { kind: 'api', label: 'A provider with an API key' },
  { kind: 'local', label: 'A model server on this machine' },
  { kind: 'agent', label: 'An agent installed on this machine' },
]

export interface ProvidersPanel {
  root: HTMLFieldSetElement
  refresh: (snapshot?: SettingsSnapshot, signal?: AbortSignal) => Promise<void>
  reset: () => void
  readUpdate: () => SettingsUpdate
  /** Persist keys typed into any provider form (called on dialog save). */
  /** False leaves the host dialog open with an inline key-storage error. */
  saveKeys: () => Promise<boolean>
}

export function createProvidersPanel(
  api: ApiClient,
  opts: {
    /** LM Studio and any other provider with its own bespoke local form. */
    nativeLocalProviders?: readonly NativeProvider[]
    /**
     * Whether picking a curated preset may run ACP auto-setup (which can install
     * adapter packages). Defaults to true (Settings). Onboarding mounts with
     * false so first-run stays side-effect-free: badges still refresh via the
     * cheap PATH scan, installs wait for first use.
     */
    deviceAutoSetup?: boolean
  } = {},
): ProvidersPanel {
  const rebuild = (): void => {
    renderChips()
    renderForm()
  }

  const apiPanel = createCustomProvidersSection(api, {
    variant: 'cloud',
    embedded: true,
    onChanged: rebuild,
  })
  const chatGptPlan = createChatGptPlanSection(api, () => {
    renderChips()
    if (selected === 'openai') renderForm()
  })
  const localPanel = createCustomProvidersSection(api, {
    variant: 'local',
    embedded: true,
    onChanged: rebuild,
    onStatusChanged: renderChips,
    ...(opts.nativeLocalProviders ? { nativeProviders: opts.nativeLocalProviders } : {}),
  })
  const agentsPanel = createAcpAgentsSection(api, { embedded: true, onChanged: rebuild })

  const pasteKey = createPasteKeyForm(api, {
    providers: () =>
      apiPanel.providerIds().map((id) => ({ id, label: apiPanel.labelFor(id) ?? id })),
    onSaved: () => {
      void refresh()
    },
    renderOther: () => {
      apiPanel.select(ADD_KEY)
      return apiPanel.root
    },
  })

  const chipRow = el('div', { class: 'provider-chips', role: 'tablist' })
  const formHost = el('div', { class: 'provider-form-host' })
  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'API keys'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Add a key and its models show up in the model picker. Pick a provider to ' +
        'add its key, set up its agent, or connect a model server you run yourself.',
    ),
    chipRow,
    formHost,
  )

  // Nothing is open until the user picks a chip: opening Settings should show
  // the list of providers, not drop you into whichever one happened to sort
  // first, and an unopened provider is one that cannot scan or auto-set-up.
  let selected = ''
  // Sub-selection within a provider that offers more than one of a capability
  // (Anthropic ships two agent builds, for instance).
  let selectedAgentId = ''
  let selectedAddKind: AddKind = 'api'
  const expandedConnections = new Set<string>()
  // Two costs, gated separately. Scanning the device for installed agents walks
  // PATH and the process list: cheap enough to run as soon as an agent is on
  // screen, so its installed / running badge is honest. Auto-setup can install
  // adapters, so it waits until the user has actually picked that provider.
  let deviceScanned = false
  let providerPicked = false
  let autoSetupRun = false

  const deviceAutoSetup = opts.deviceAutoSetup ?? true

  function loadDeviceInfoOnce(agentId?: string): void {
    const preset = KNOWN_ACP_AGENTS.some((agent) => agent.id === agentId && agent.preset)
    if (deviceAutoSetup && providerPicked && preset && !autoSetupRun) {
      autoSetupRun = true
      deviceScanned = true
      void agentsPanel.refresh()
      return
    }
    if (!deviceScanned) {
      deviceScanned = true
      void agentsPanel.scan()
    }
  }

  /** The capabilities a provider actually has right now, panels included. */
  function resolve(vendor: VendorSpec): {
    api: string[]
    local: string[]
    agents: string[]
  } {
    return {
      api: (vendor.api ?? []).filter((id) => apiPanel.labelFor(id) !== null),
      local: (vendor.local ?? []).filter((id) => localPanel.labelFor(id) !== null),
      agents: (vendor.agents ?? []).filter((id) => agentsPanel.labelFor(id) !== null),
    }
  }

  function hasAnything(vendor: VendorSpec): boolean {
    const caps = resolve(vendor)
    return Boolean(caps.api.length || caps.local.length || caps.agents.length)
  }

  /**
   * Chips in display order: merged providers first (they are the ones people
   * reach for), then whatever each panel still has to offer, then "Add".
   */
  function vendors(): VendorSpec[] {
    const list: VendorSpec[] = []
    const claimed = new Set<string>()
    for (const vendor of MERGED_VENDORS) {
      if (!hasAnything(vendor)) continue
      list.push(vendor)
      for (const id of [...(vendor.api ?? []), ...(vendor.local ?? []), ...(vendor.agents ?? [])]) {
        claimed.add(id)
      }
    }
    for (const id of apiPanel.providerIds()) {
      if (claimed.has(id)) continue
      list.push({ id, label: apiPanel.labelFor(id) ?? id, api: [id] })
    }
    for (const id of agentsPanel.agentIds()) {
      if (claimed.has(id)) continue
      list.push({ id, label: agentsPanel.labelFor(id) ?? id, agents: [id] })
    }
    for (const id of localPanel.providerIds()) {
      if (claimed.has(id)) continue
      list.push({ id, label: localPanel.labelFor(id) ?? id, local: [id] })
    }
    return list
  }

  function isConfigured(vendor: VendorSpec): boolean {
    if (vendor.id === 'openai' && chatGptPlan.configured()) return true
    const caps = resolve(vendor)
    if (caps.api.some((id) => apiPanel.isConfigured(id))) return true
    if (caps.local.some((id) => localPanel.isConfigured(id))) return true
    return caps.agents.some((id) => agentsPanel.isConfigured(id))
  }

  function renderChips(): void {
    clear(chipRow)
    for (const vendor of [...vendors(), { id: ADD_KEY, label: 'Add' }]) {
      const chip = el(
        'button',
        { type: 'button', class: 'provider-chip', role: 'tab' },
        vendor.label,
      )
      chip.dataset['provider'] = vendor.id
      chip.classList.toggle('active', vendor.id === selected)
      if (vendor.id !== ADD_KEY && isConfigured(vendor)) {
        chip.append(el('span', { class: 'provider-chip-dot', title: 'Set up' }))
      }
      chip.addEventListener('click', () => {
        if (vendor.id === 'openai' && selected !== 'openai') void chatGptPlan.refresh()
        selected = vendor.id
        selectedAgentId = ''
        // Picking a provider is the signal that a device scan is worth its cost.
        providerPicked = true
        renderChips()
        renderForm()
      })
      chipRow.append(chip)
    }
  }

  /** A titled capability block inside the selected provider's form. */
  function block(title: string, ...children: (Node | string)[]): HTMLElement {
    return el(
      'div',
      { class: 'provider-capability' },
      el('h4', { class: 'provider-capability-title' }, title),
      ...children,
    )
  }

  function agentBlock(agentIds: string[]): HTMLElement {
    if (!agentIds.includes(selectedAgentId)) selectedAgentId = agentIds[0] ?? ''
    const children: (Node | string)[] = []
    // More than one build of the same agent (Anthropic ships two): let the user
    // choose which one this provider means before showing its form.
    if (agentIds.length > 1) {
      const picker = el('select', {})
      for (const id of agentIds) {
        picker.append(el('option', { value: id }, agentsPanel.labelFor(id) ?? id))
      }
      picker.value = selectedAgentId
      picker.addEventListener('change', () => {
        selectedAgentId = picker.value
        renderForm()
      })
      children.push(el('label', {}, 'Version', picker))
    }
    agentsPanel.select(selectedAgentId)
    children.push(agentsPanel.root)
    loadDeviceInfoOnce(selectedAgentId)
    return block('On this machine', ...children)
  }

  function addForm(): HTMLElement {
    const picker = el('select', {})
    for (const entry of ADD_KINDS) {
      picker.append(el('option', { value: entry.kind }, entry.label))
    }
    picker.value = selectedAddKind
    picker.addEventListener('change', () => {
      const next = ADD_KINDS.find((entry) => entry.kind === picker.value)
      selectedAddKind = next?.kind ?? 'api'
      renderForm()
    })
    const host = el('div', { class: 'provider-add-host' })
    if (selectedAddKind === 'api') {
      // Paste a key and let Copse work out the provider; "Other" falls through to
      // the full custom-endpoint form below.
      host.append(pasteKey.root)
    } else if (selectedAddKind === 'local') {
      localPanel.select(ADD_KEY)
      host.append(localPanel.root)
    } else {
      agentsPanel.select(ADD_KEY)
      host.append(agentsPanel.root)
      loadDeviceInfoOnce()
    }
    return el(
      'div',
      { class: 'provider-vendor' },
      el('label', {}, 'What are you adding?', picker),
      host,
    )
  }

  function connectionDetails(
    id: string,
    label: string,
    ...children: HTMLElement[]
  ): HTMLDetailsElement {
    const details = el('details', { 'data-testid': id }, el('summary', {}, label), ...children)
    details.open = expandedConnections.has(id)
    details.addEventListener('toggle', () => {
      if (details.open) expandedConnections.add(id)
      else expandedConnections.delete(id)
    })
    return details
  }

  function openAiCards(agentIds: string[]): HTMLElement {
    const cards = el('div', { class: 'provider-vendor openai-connections' })
    apiPanel.select('openai')
    const apiDetails = connectionDetails(
      'openai-api-details',
      'Configure API access',
      apiPanel.root,
    )
    const entries = [
      {
        title: 'ChatGPT plan',
        configured: chatGptPlan.configured(),
        description: 'Copse’s agent and tools, using your ChatGPT plan or available credits.',
        content: chatGptPlan.root,
        id: 'chatgpt',
      },
      {
        title: 'OpenAI API',
        configured: apiPanel.isConfigured('openai'),
        description: 'Copse’s agent and tools, billed to your OpenAI API account.',
        content: apiDetails,
        id: 'api',
      },
    ]
    if (agentIds.length) {
      entries.push({
        title: 'Codex agent',
        configured: agentIds.some((id) => agentsPanel.isConfigured(id)),
        description: 'Codex’s agent, running on this machine.',
        content: connectionDetails(
          'openai-codex-details',
          'Configure Codex agent',
          agentBlock(agentIds),
        ),
        id: 'codex',
      })
    }
    entries.sort((a, b) => Number(b.configured) - Number(a.configured))
    for (const entry of entries) {
      cards.append(
        el(
          'section',
          { class: 'openai-connection-card', 'data-connection': entry.id },
          el(
            'div',
            { class: 'openai-connection-heading' },
            el('h4', {}, entry.title),
            el('span', { class: 'field-hint' }, entry.configured ? 'Set up' : 'Not set up'),
          ),
          el('p', { class: 'field-hint' }, entry.description),
          entry.content,
        ),
      )
    }
    return cards
  }

  function renderForm(): void {
    clear(formHost)
    if (!selected) return
    if (selected === ADD_KEY) {
      formHost.append(addForm())
      return
    }
    const vendor = vendors().find((entry) => entry.id === selected)
    if (!vendor) return
    const caps = resolve(vendor)
    if (vendor.id === 'openai') {
      formHost.append(openAiCards(caps.agents))
      return
    }
    const body = el('div', { class: 'provider-vendor' })
    if (caps.api.length) {
      const [first] = caps.api
      if (first !== undefined) {
        apiPanel.select(first)
        body.append(block('API key', apiPanel.root))
      }
    }
    if (caps.agents.length) body.append(agentBlock(caps.agents))
    if (caps.local.length) {
      const [first] = caps.local
      if (first !== undefined) {
        localPanel.select(first)
        body.append(block('Model server on this machine', localPanel.root))
      }
    }
    formHost.append(body)
  }

  let refreshGeneration = 0
  async function refresh(snapshot?: SettingsSnapshot, signal?: AbortSignal): Promise<void> {
    const mine = ++refreshGeneration
    if (signal?.aborted) return
    // Each panel's own refresh fires `onChanged`, which repaints the chip row as
    // its data lands; the final rebuild below settles the selection once all
    // three have reported in.
    await apiPanel.refresh(snapshot, signal)
    if (mine !== refreshGeneration || signal?.aborted) return
    await localPanel.refresh(snapshot, signal)
    if (mine !== refreshGeneration || signal?.aborted) return
    await agentsPanel.reload(signal)
    if (mine !== refreshGeneration || signal?.aborted) return
    if (selected === 'openai') await chatGptPlan.refresh()
    if (mine !== refreshGeneration || signal?.aborted) return
    // A provider that has gone away closes back to the list rather than
    // handing the selection to an unrelated one.
    if (selected !== ADD_KEY && !vendors().some((vendor) => vendor.id === selected)) {
      selected = ''
    }
    pasteKey.refreshChoices()
    rebuild()
  }

  async function saveKeys(): Promise<boolean> {
    const [apiSaved, localSaved] = await Promise.all([apiPanel.saveKeys(), localPanel.saveKeys()])
    return apiSaved && localSaved
  }

  return {
    root: fieldset,
    refresh,
    saveKeys,
    reset: (): void => {
      refreshGeneration += 1
      pasteKey.reset()
      apiPanel.reset()
      localPanel.reset()
      selected = ''
      rebuild()
    },
    readUpdate: () => ({
      ...apiPanel.readUpdate(),
      ...localPanel.readUpdate(),
    }),
  }
}
