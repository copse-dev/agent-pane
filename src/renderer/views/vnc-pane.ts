import RFB from '@novnc/novnc'
import { el, qsRequired } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { VncDiscoveryHost, VncNearbyServer, VncTarget } from '@shared/types/vnc.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { VncIpcChannel } from './vnc-channel.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

function vncModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'vnc'
}

const LOCAL_MACHINE = 'local'
const MANUAL_MACHINE = 'network:manual'
const NEARBY_MACHINE_PREFIX = 'network:nearby:'
const SSH_MACHINE_PREFIX = 'ssh:'

function discoveryHost(machine: string): VncDiscoveryHost {
  if (machine.startsWith(SSH_MACHINE_PREFIX)) {
    return { kind: 'ssh', hostId: machine.slice(SSH_MACHINE_PREFIX.length) }
  }
  if (machine === LOCAL_MACHINE) return { kind: 'local' }
  throw new Error('Choose this machine or a saved SSH machine before scanning ports')
}

function sshMachineValue(hostId: string): string {
  return `${SSH_MACHINE_PREFIX}${hostId}`
}

function isNetworkMachine(machine: string): boolean {
  return machine === MANUAL_MACHINE || machine.startsWith(NEARBY_MACHINE_PREFIX)
}

function hostLabel(host: SshWorkspaceHost): string {
  const address = host.user ? `${host.user}@${host.host}` : host.host
  return host.label === address ? host.label : `${host.label} · ${address}`
}

function discoveredDisplayLabel(port: number): string {
  return port >= 5900 && port <= 5999 ? `Display :${String(port - 5900)}` : 'VNC server'
}

export function mountVncPane(
  controlsRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const header = el(
    'div',
    { class: 'git-changes-header' },
    el('span', { class: 'git-changes-title' }, 'Desktop'),
    panePopoutButton(store, api, 'vnc', 'desktop'),
    paneMaximizeButton(store, 'desktop'),
  )
  const machineSelect = el('select', {
    class: 'vnc-machine-select',
    'aria-label': 'VNC machine',
  })
  machineSelect.append(el('option', { value: LOCAL_MACHINE }, 'This machine'))
  const nearbyButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary vnc-nearby-btn' },
    'Find nearby devices',
  )
  const nearbyStatus = el(
    'div',
    { class: 'vnc-nearby-status', role: 'status' },
    'Looking for advertised VNC services…',
  )
  const addressInput = el('input', {
    type: 'text',
    class: 'vnc-address-input',
    placeholder: '192.168.1.20 or studio.local',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'VNC hostname or IP address',
  })
  const addressField = el(
    'label',
    { class: 'vnc-field-label', hidden: true },
    'Hostname or IP address',
    addressInput,
  )
  const portInput = el('input', {
    type: 'number',
    class: 'vnc-port-input',
    min: '1',
    max: '65535',
    value: '5901',
    'aria-label': 'VNC port',
  })
  const connectButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary vnc-connect-btn' },
    'Connect',
  )
  const disconnectButton = el(
    'button',
    { type: 'button', class: 'ui-btn vnc-disconnect-btn', hidden: true },
    'Disconnect',
  )
  const discoverButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary vnc-discover-btn' },
    'Find VNC servers',
  )
  const discoveryStatus = el(
    'div',
    { class: 'vnc-discovery-status', role: 'status' },
    'Scanning this machine…',
  )
  const discoveredPorts = el('div', {
    class: 'vnc-discovered-ports',
    'aria-label': 'Discovered VNC servers',
    hidden: true,
  })
  const networkWarning = el(
    'div',
    { class: 'vnc-network-warning', role: 'note', hidden: true },
    'Direct VNC is unencrypted. Only connect on a network you trust.',
  )
  const status = el('div', { class: 'vnc-status', role: 'status' }, 'Not connected')
  const form = el(
    'div',
    { class: 'vnc-connect-form' },
    el('label', { class: 'vnc-field-label' }, 'Machine', machineSelect),
    nearbyButton,
    nearbyStatus,
    addressField,
    el('label', { class: 'vnc-field-label' }, 'RFB port', portInput),
    discoverButton,
    discoveryStatus,
    discoveredPorts,
    networkWarning,
    connectButton,
    disconnectButton,
  )
  const note = el(
    'p',
    { class: 'vnc-view-only-note' },
    'View only. Keyboard, pointer, and clipboard input are disabled.',
  )
  controlsRoot.append(header, el('div', { class: 'vnc-controls-body' }, form, status, note))

  const screen = el('div', { class: 'vnc-screen', 'aria-label': 'Remote desktop' })
  const empty = el(
    'div',
    { class: 'panel-empty vnc-empty' },
    'Choose this machine, a nearby device, another address, or a saved SSH machine.',
  )
  viewerRoot.append(screen, empty)

  let rfb: RFB | null = null
  let channel: VncIpcChannel | null = null
  let connectGeneration = 0
  let discoveryGeneration = 0
  let nearbyGeneration = 0
  let sshHosts: SshWorkspaceHost[] = []
  let nearbyServers: VncNearbyServer[] = []

  function setConnectedUi(connected: boolean): void {
    connectButton.hidden = connected
    disconnectButton.hidden = !connected
    portInput.disabled = connected
    addressInput.disabled = connected
    machineSelect.disabled = connected
    discoverButton.disabled = connected
    nearbyButton.disabled = connected
    for (const button of discoveredPorts.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = connected
    }
    empty.hidden = connected
    screen.hidden = !connected
  }

  function setStatus(message: string, kind: 'idle' | 'working' | 'ok' | 'error'): void {
    status.textContent = message
    status.dataset['kind'] = kind
  }

  function clearViewer(message: string, kind: 'idle' | 'error' = 'idle'): void {
    rfb = null
    channel = null
    screen.replaceChildren()
    setConnectedUi(false)
    setStatus(message, kind)
  }

  function nearbyMachineValue(index: number): string {
    return `${NEARBY_MACHINE_PREFIX}${String(index)}`
  }

  function selectedNearbyServer(): VncNearbyServer | null {
    if (!machineSelect.value.startsWith(NEARBY_MACHINE_PREFIX)) return null
    const index = Number.parseInt(machineSelect.value.slice(NEARBY_MACHINE_PREFIX.length), 10)
    return nearbyServers[index] ?? null
  }

  function preferredNearbyAddress(server: VncNearbyServer): string {
    const host = server.host.trim()
    return (
      server.addresses.find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) ??
      (host ? host : (server.addresses[0] ?? ''))
    )
  }

  function rebuildMachineOptions(preferred: string): void {
    machineSelect.replaceChildren(el('option', { value: LOCAL_MACHINE }, 'This machine'))
    if (nearbyServers.length > 0) {
      const nearbyGroup = el('optgroup', { label: 'Nearby devices' })
      nearbyServers.forEach((server, index) => {
        nearbyGroup.append(
          el(
            'option',
            { value: nearbyMachineValue(index) },
            `${server.name} · ${server.host}:${String(server.port)}`,
          ),
        )
      })
      machineSelect.append(nearbyGroup)
    }
    machineSelect.append(el('option', { value: MANUAL_MACHINE }, 'Other address…'))
    if (sshHosts.length > 0) {
      const sshGroup = el('optgroup', { label: 'Saved SSH machines' })
      for (const host of sshHosts) {
        sshGroup.append(el('option', { value: sshMachineValue(host.id) }, hostLabel(host)))
      }
      machineSelect.append(sshGroup)
    }
    if ([...machineSelect.options].some((option) => option.value === preferred)) {
      machineSelect.value = preferred
    }
  }

  function updateMachineUi(): void {
    const network = isNetworkMachine(machineSelect.value)
    addressField.hidden = !network
    networkWarning.hidden = !network
    discoverButton.hidden = network
    discoveryStatus.hidden = network
    if (network) {
      discoveryGeneration++
      renderDiscoveredPorts([])
    }
    const nearby = selectedNearbyServer()
    if (nearby) {
      addressInput.value = preferredNearbyAddress(nearby)
      portInput.value = String(nearby.port)
    } else if (machineSelect.value === MANUAL_MACHINE && !addressInput.value) {
      portInput.value = '5900'
    }
  }

  function selectedTarget(port: number): VncTarget {
    if (machineSelect.value.startsWith(SSH_MACHINE_PREFIX)) {
      return {
        kind: 'ssh',
        hostId: machineSelect.value.slice(SSH_MACHINE_PREFIX.length),
        remotePort: port,
      }
    }
    if (isNetworkMachine(machineSelect.value)) {
      return {
        kind: 'network',
        host: addressInput.value.trim(),
        port,
        confirmedUnencrypted: true,
      }
    }
    return { kind: 'loopback', port }
  }

  function highlightDiscoveredPort(port: number): void {
    for (const button of discoveredPorts.querySelectorAll<HTMLButtonElement>('button')) {
      button.classList.toggle('selected', button.dataset['port'] === String(port))
    }
  }

  function chooseDiscoveredPort(port: number): void {
    portInput.value = String(port)
    highlightDiscoveredPort(port)
  }

  function renderDiscoveredPorts(ports: readonly number[]): void {
    discoveredPorts.replaceChildren()
    discoveredPorts.hidden = ports.length === 0
    for (const port of ports) {
      const button = el(
        'button',
        {
          type: 'button',
          class: 'vnc-discovered-port',
          'data-port': String(port),
          'aria-label': `${discoveredDisplayLabel(port)}, port ${String(port)}`,
        },
        el('span', {}, discoveredDisplayLabel(port)),
        el('span', { class: 'vnc-discovered-port-number' }, String(port)),
      )
      button.addEventListener('click', () => {
        chooseDiscoveredPort(port)
      })
      discoveredPorts.append(button)
    }
    if (ports[0] !== undefined) chooseDiscoveredPort(ports[0])
  }

  async function discoverSelectedMachine(): Promise<void> {
    if (isNetworkMachine(machineSelect.value)) return
    const generation = ++discoveryGeneration
    discoverButton.disabled = true
    discoveryStatus.dataset['kind'] = 'working'
    discoveryStatus.textContent =
      discoveryHost(machineSelect.value).kind === 'ssh'
        ? 'Connecting over SSH and scanning for VNC…'
        : 'Scanning this machine for VNC…'
    renderDiscoveredPorts([])
    try {
      const ports = await api.vnc.discover(discoveryHost(machineSelect.value))
      if (generation !== discoveryGeneration) return
      renderDiscoveredPorts(ports)
      discoveryStatus.dataset['kind'] = ports.length > 0 ? 'ok' : 'idle'
      discoveryStatus.textContent =
        ports.length === 0
          ? 'No VNC servers found. You can still enter a port manually.'
          : `${String(ports.length)} VNC ${ports.length === 1 ? 'server' : 'servers'} found.`
    } catch (error) {
      if (generation !== discoveryGeneration) return
      discoveryStatus.dataset['kind'] = 'error'
      discoveryStatus.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === discoveryGeneration) discoverButton.disabled = channel !== null
    }
  }

  async function discoverNearby(): Promise<void> {
    const generation = ++nearbyGeneration
    const previous = machineSelect.value
    const previousNearby = selectedNearbyServer()
    nearbyButton.disabled = true
    nearbyStatus.dataset['kind'] = 'working'
    nearbyStatus.textContent = 'Looking for advertised VNC services…'
    try {
      const servers = await api.vnc.discoverNearby()
      if (generation !== nearbyGeneration) return
      nearbyServers = servers
      const matchingNearbyIndex = previousNearby
        ? servers.findIndex(
            (server) => server.host === previousNearby.host && server.port === previousNearby.port,
          )
        : -1
      const preferred = previousNearby
        ? matchingNearbyIndex >= 0
          ? nearbyMachineValue(matchingNearbyIndex)
          : LOCAL_MACHINE
        : previous
      rebuildMachineOptions(preferred)
      updateMachineUi()
      nearbyStatus.dataset['kind'] = servers.length > 0 ? 'ok' : 'idle'
      nearbyStatus.textContent =
        servers.length === 0
          ? 'No nearby VNC devices advertised. Use Other address if you know its IP.'
          : `${String(servers.length)} nearby ${servers.length === 1 ? 'device' : 'devices'} found.`
    } catch (error) {
      if (generation !== nearbyGeneration) return
      nearbyStatus.dataset['kind'] = 'error'
      nearbyStatus.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === nearbyGeneration) nearbyButton.disabled = channel !== null
    }
  }

  async function loadMachines(): Promise<void> {
    const previous = machineSelect.value
    try {
      const sshEnabled = (await api.settings.get('sshWorkspaceEnabled')) === true
      sshHosts = sshEnabled ? await api.sshWorkspace.listHosts() : []
      const activeProject = store
        .getState()
        .projects.find((project) => project.id === store.getState().activeProjectId)
      const preferred = activeProject?.sshHost ? sshMachineValue(activeProject.sshHost) : previous
      rebuildMachineOptions(preferred)
    } catch {
      sshHosts = []
      rebuildMachineOptions(LOCAL_MACHINE)
    }
    updateMachineUi()
    await Promise.all([discoverSelectedMachine(), discoverNearby()])
  }

  async function connect(): Promise<void> {
    const port = Number.parseInt(portInput.value, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setStatus('Enter a port from 1 to 65535.', 'error')
      return
    }
    const target = selectedTarget(port)
    if (target.kind === 'network') {
      if (!target.host) {
        setStatus('Enter a hostname or IP address.', 'error')
        return
      }
      const confirmed = await showConfirmDialog({
        message: `Connect directly to ${target.host}:${String(target.port)}?`,
        detail:
          'Standard VNC does not encrypt the screen or session data. Continue only on a network you trust; use a saved SSH machine when possible.',
        confirmLabel: 'Connect unencrypted',
        danger: true,
      })
      if (!confirmed) return
    }
    const generation = ++connectGeneration
    connectButton.disabled = true
    setStatus(
      target.kind === 'network'
        ? 'Opening direct network connection…'
        : 'Opening secure connection…',
      'working',
    )
    try {
      const connection = await api.vnc.open(target)
      if (generation !== connectGeneration) {
        await api.vnc.close(connection.id)
        return
      }
      const nextChannel = new VncIpcChannel(connection.id, api)
      channel = nextChannel
      const nextRfb = new RFB(screen, nextChannel, { shared: true })
      rfb = nextRfb
      nextRfb.viewOnly = true
      nextRfb.scaleViewport = true
      nextRfb.clipViewport = false
      nextRfb.resizeSession = false
      nextRfb.background = 'var(--bg-base)'
      nextRfb.addEventListener('connect', () => {
        setConnectedUi(true)
        setStatus('Connected · view only', 'ok')
      })
      nextRfb.addEventListener('disconnect', (event) => {
        const message = event.detail.clean ? 'Disconnected' : 'Desktop connection lost'
        clearViewer(message, event.detail.clean ? 'idle' : 'error')
      })
      nextRfb.addEventListener('credentialsrequired', () => {
        setStatus(
          'This server requires credentials; password support is not available yet.',
          'error',
        )
        nextRfb.disconnect()
      })
      nextRfb.addEventListener('securityfailure', () => {
        setStatus('The server refused VNC security negotiation.', 'error')
      })
      queueMicrotask(() => {
        nextChannel.open()
      })
    } catch (error) {
      clearViewer(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      connectButton.disabled = false
    }
  }

  function disconnect(): void {
    connectGeneration++
    setStatus('Disconnecting…', 'working')
    if (rfb) rfb.disconnect()
    else channel?.close()
  }

  connectButton.addEventListener('click', () => {
    void connect()
  })
  disconnectButton.addEventListener('click', disconnect)
  discoverButton.addEventListener('click', () => {
    void discoverSelectedMachine()
  })
  nearbyButton.addEventListener('click', () => {
    void discoverNearby()
  })
  machineSelect.addEventListener('change', () => {
    updateMachineUi()
    void discoverSelectedMachine()
  })
  portInput.addEventListener('input', () => {
    highlightDiscoveredPort(Number.parseInt(portInput.value, 10))
  })
  portInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })
  addressInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })

  const stopData = api.vnc.onData((connectionId, bytes) => {
    if (channel?.connectionId === connectionId) channel.receive(bytes)
  })
  const stopStatus = api.vnc.onStatus((event) => {
    channel?.handleStatus(event)
  })
  const stopWorkspace = store.on('workspace_changed', () => {
    if (channel) disconnect()
  })
  const stopMode = store.on('right_panel_mode_changed', () => {
    if (vncModeActive(store) && rfb) rfb.focus()
  })

  setConnectedUi(false)
  qsRequired<HTMLInputElement>(form, '.vnc-port-input').value = '5901'
  void loadMachines()

  return () => {
    connectGeneration++
    discoveryGeneration++
    nearbyGeneration++
    rfb?.disconnect()
    channel?.close()
    stopData()
    stopStatus()
    stopWorkspace()
    stopMode()
  }
}
