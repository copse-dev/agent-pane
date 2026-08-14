import RFB from '@novnc/novnc'
import { el, qsRequired } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { VncDiscoveryHost, VncTarget } from '@shared/types/vnc.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { VncIpcChannel } from './vnc-channel.ts'

function vncModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'vnc'
}

const LOCAL_MACHINE = 'local'
const SSH_MACHINE_PREFIX = 'ssh:'

function discoveryHost(machine: string): VncDiscoveryHost {
  if (machine.startsWith(SSH_MACHINE_PREFIX)) {
    return { kind: 'ssh', hostId: machine.slice(SSH_MACHINE_PREFIX.length) }
  }
  return { kind: 'local' }
}

function selectedTarget(machine: string, port: number): VncTarget {
  const host = discoveryHost(machine)
  return host.kind === 'ssh'
    ? { kind: 'ssh', hostId: host.hostId, remotePort: port }
    : { kind: 'loopback', port }
}

function sshMachineValue(hostId: string): string {
  return `${SSH_MACHINE_PREFIX}${hostId}`
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
  const status = el('div', { class: 'vnc-status', role: 'status' }, 'Not connected')
  const form = el(
    'div',
    { class: 'vnc-connect-form' },
    el('label', { class: 'vnc-field-label' }, 'Machine', machineSelect),
    el('label', { class: 'vnc-field-label' }, 'RFB port', portInput),
    discoverButton,
    discoveryStatus,
    discoveredPorts,
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
    'Choose this machine or a configured SSH machine, then connect to a discovered VNC server.',
  )
  viewerRoot.append(screen, empty)

  let rfb: RFB | null = null
  let channel: VncIpcChannel | null = null
  let connectGeneration = 0
  let discoveryGeneration = 0

  function setConnectedUi(connected: boolean): void {
    connectButton.hidden = connected
    disconnectButton.hidden = !connected
    portInput.disabled = connected
    machineSelect.disabled = connected
    discoverButton.disabled = connected
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

  async function discover(): Promise<void> {
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

  async function loadMachines(): Promise<void> {
    const previous = machineSelect.value
    const localOption = machineSelect.querySelector('option')
    machineSelect.replaceChildren()
    if (localOption) machineSelect.append(localOption)
    try {
      const sshEnabled = (await api.settings.get('sshWorkspaceEnabled')) === true
      const hosts = sshEnabled ? await api.sshWorkspace.listHosts() : []
      for (const host of hosts) {
        machineSelect.append(el('option', { value: sshMachineValue(host.id) }, hostLabel(host)))
      }
      const activeProject = store
        .getState()
        .projects.find((project) => project.id === store.getState().activeProjectId)
      const preferred = activeProject?.sshHost ? sshMachineValue(activeProject.sshHost) : previous
      if ([...machineSelect.options].some((option) => option.value === preferred)) {
        machineSelect.value = preferred
      }
    } catch {
      machineSelect.value = LOCAL_MACHINE
    }
    await discover()
  }

  async function connect(): Promise<void> {
    const port = Number.parseInt(portInput.value, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setStatus('Enter a port from 1 to 65535.', 'error')
      return
    }
    const generation = ++connectGeneration
    connectButton.disabled = true
    setStatus('Opening secure connection…', 'working')
    try {
      const connection = await api.vnc.open(selectedTarget(machineSelect.value, port))
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
    void discover()
  })
  machineSelect.addEventListener('change', () => {
    void discover()
  })
  portInput.addEventListener('input', () => {
    highlightDiscoveredPort(Number.parseInt(portInput.value, 10))
  })
  portInput.addEventListener('keydown', (event) => {
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
    rfb?.disconnect()
    channel?.close()
    stopData()
    stopStatus()
    stopWorkspace()
    stopMode()
  }
}
