import type { ApiClient } from '../../../preload/api.d.ts'
import { el, clear } from '../../dom/helpers.ts'
import { createCustomProvidersSection, type NativeProvider } from './custom-providers-section.ts'
import { createAcpAgentsSection } from './acp-agents-section.ts'

// The one "Providers" panel in Settings > General. A provider is a company, not
// a wiring mechanism: picking Cursor shows everything Cursor can do here (its
// cloud agent and the Cursor agent installed on this device), picking Anthropic
// shows its API key, its cloud agent, and the Claude agent on this device.
//
// Under the hood that is four separate panels — cloud API keys, local servers,
// device agents, and cloud agents — which used to be four separate settings
// sections. This module owns a single chip row across all of them and shows only
// the blocks the selected provider actually offers.

/**
 * A cloud agent (a provider that runs whole turns on its own machines) supplied
 * by the host, which owns the API-key sections it needs.
 */
export interface CloudAgentPanel {
  /** Provider chip this cloud agent belongs to. */
  vendor: string
  /** Authentication + guidance element, built by the host. */
  element: HTMLElement
  /** Key slugs whose presence marks this provider as set up. */
  keySlugs: readonly string[]
}

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
    agents: ['claude-agent-acp', 'claude-code-acp'],
  },
  { id: 'openai', label: 'OpenAI', api: ['openai'], agents: ['codex'] },
  { id: 'cursor', label: 'Cursor', agents: ['cursor'] },
  { id: 'gemini', label: 'Google Gemini', api: ['gemini'], agents: ['gemini-cli'] },
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
  refresh: () => Promise<void>
  /** Persist keys typed into any provider form (called on dialog save). */
  saveKeys: () => Promise<void>
}

export function createProvidersPanel(
  api: ApiClient,
  opts: {
    /** LM Studio and any other provider with its own bespoke local form. */
    nativeLocalProviders?: readonly NativeProvider[]
    cloudAgents?: readonly CloudAgentPanel[]
    /** Options that apply to whichever cloud agent runs, shown with them. */
    cloudAgentOptions?: HTMLElement
  } = {},
): ProvidersPanel {
  const cloudAgents = opts.cloudAgents ?? []
  const cloudAgentByVendor = new Map(cloudAgents.map((entry) => [entry.vendor, entry]))
  // Key slugs behind a cloud agent, so its chip can show a configured dot.
  const cloudAgentKeys = new Set<string>()

  const rebuild = (): void => {
    renderChips()
    renderForm()
  }

  const apiPanel = createCustomProvidersSection(api, {
    variant: 'cloud',
    embedded: true,
    onChanged: rebuild,
  })
  const localPanel = createCustomProvidersSection(api, {
    variant: 'local',
    embedded: true,
    onChanged: rebuild,
    ...(opts.nativeLocalProviders ? { nativeProviders: opts.nativeLocalProviders } : {}),
  })
  const agentsPanel = createAcpAgentsSection(api, { embedded: true, onChanged: rebuild })

  const chipRow = el('div', { class: 'provider-chips', role: 'tablist' })
  const formHost = el('div', { class: 'provider-form-host' })
  // The cloud-agent run options carry named form controls, so they stay parented
  // here for the life of the dialog and are only hidden when the selected
  // provider has no cloud agent. Re-parenting them per selection would drop them
  // out of the form and silently lose their values on save.
  const cloudAgentOptions = opts.cloudAgentOptions
  if (cloudAgentOptions) cloudAgentOptions.hidden = true

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Providers'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Everything Copse can send a turn to. Pick a provider to set up its API ' +
        'key, its cloud agent, the copy of it installed on this machine, or a ' +
        'model server you run yourself. Whatever you set up here shows up in the ' +
        'model picker.',
    ),
    chipRow,
    formHost,
    ...(cloudAgentOptions ? [cloudAgentOptions] : []),
  )

  // Nothing is open until the user picks a chip: opening Settings should show
  // the list of providers, not drop you into whichever one happened to sort
  // first, and an unopened provider is one that cannot scan or auto-set-up.
  let selected = ''
  // Sub-selection within a provider that offers more than one of a capability
  // (Anthropic ships two agent builds, for instance).
  let selectedAgentId = ''
  let selectedAddKind: AddKind = 'api'
  // Two costs, gated separately. Scanning the device for installed agents walks
  // PATH and the process list: cheap enough to run as soon as an agent is on
  // screen, so its installed / running badge is honest. Auto-setup can install
  // adapters, so it waits until the user has actually picked that provider.
  let deviceScanned = false
  let providerPicked = false
  let autoSetupRun = false

  function loadDeviceInfoOnce(): void {
    if (providerPicked && !autoSetupRun) {
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
    cloud: CloudAgentPanel | undefined
  } {
    return {
      api: (vendor.api ?? []).filter((id) => apiPanel.labelFor(id) !== null),
      local: (vendor.local ?? []).filter((id) => localPanel.labelFor(id) !== null),
      agents: (vendor.agents ?? []).filter((id) => agentsPanel.labelFor(id) !== null),
      cloud: cloudAgentByVendor.get(vendor.id),
    }
  }

  function hasAnything(vendor: VendorSpec): boolean {
    const caps = resolve(vendor)
    return Boolean(caps.api.length || caps.local.length || caps.agents.length || caps.cloud)
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
    const caps = resolve(vendor)
    if (caps.api.some((id) => apiPanel.isConfigured(id))) return true
    if (caps.local.some((id) => localPanel.isConfigured(id))) return true
    if (caps.agents.some((id) => agentsPanel.isConfigured(id))) return true
    return caps.cloud ? caps.cloud.keySlugs.some((slug) => cloudAgentKeys.has(slug)) : false
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
    loadDeviceInfoOnce()
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
      apiPanel.select(ADD_KEY)
      host.append(apiPanel.root)
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

  function renderForm(): void {
    clear(formHost)
    if (cloudAgentOptions) cloudAgentOptions.hidden = true
    if (!selected) return
    if (selected === ADD_KEY) {
      formHost.append(addForm())
      return
    }
    const vendor = vendors().find((entry) => entry.id === selected)
    if (!vendor) return
    const caps = resolve(vendor)
    const body = el('div', { class: 'provider-vendor' })
    if (caps.api.length) {
      const [first] = caps.api
      if (first !== undefined) {
        apiPanel.select(first)
        body.append(block('API key', apiPanel.root))
      }
    }
    if (caps.cloud) {
      body.append(block('Cloud agent', caps.cloud.element))
      if (cloudAgentOptions) cloudAgentOptions.hidden = false
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

  async function refreshCloudAgentKeys(): Promise<void> {
    cloudAgentKeys.clear()
    const slugs = [...new Set(cloudAgents.flatMap((entry) => [...entry.keySlugs]))]
    await Promise.all(
      slugs.map(async (slug) => {
        try {
          if (await api.settings.getKey(slug)) cloudAgentKeys.add(slug)
        } catch {
          /* a key we can't read just leaves the chip undotted */
        }
      }),
    )
  }

  async function refresh(): Promise<void> {
    // Each panel's own refresh fires `onChanged`, which repaints the chip row as
    // its data lands; the final rebuild below settles the selection once all
    // three have reported in.
    await apiPanel.refresh()
    await localPanel.refresh()
    await agentsPanel.reload()
    await refreshCloudAgentKeys()
    // A provider that has gone away closes back to the list rather than
    // handing the selection to an unrelated one.
    if (selected !== ADD_KEY && !vendors().some((vendor) => vendor.id === selected)) {
      selected = ''
    }
    rebuild()
  }

  async function saveKeys(): Promise<void> {
    await apiPanel.saveKeys()
    await localPanel.saveKeys()
  }

  return { root: fieldset, refresh, saveKeys }
}
