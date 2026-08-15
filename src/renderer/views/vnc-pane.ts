import RFB from '@novnc/novnc'
import { el, qsRequired } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type {
  VncDiscoveryHost,
  VncNearbyServer,
  VncSshHostResolution,
  VncTarget,
} from '@shared/types/vnc.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { VncIpcChannel } from './vnc-channel.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { dedupeNearbyVncServers, parseVncEndpoint, preferredVncUsername } from './vnc-machines.ts'

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

function discoveredDisplayLabel(port: number, optionIndex = 0): string {
  const label = port >= 5900 && port <= 5999 ? 'Screen sharing' : 'Remote desktop'
  return optionIndex === 0 ? label : `${label} option ${String(optionIndex + 1)}`
}

type VncStatusKind = 'idle' | 'working' | 'ok' | 'error'
type VncCredentialType = 'username' | 'password' | 'target'

interface PendingStatus {
  title: string
  detail: string
  kind: VncStatusKind
}

function isVncCredentialType(type: string): type is VncCredentialType {
  return type === 'username' || type === 'password' || type === 'target'
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
    'aria-label': 'Desktop machine',
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
    'Looking for nearby desktops…',
  )
  const addressInput = el('input', {
    type: 'text',
    class: 'vnc-address-input',
    placeholder: 'studio.local or studio.local:5901',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Desktop hostname or IP address',
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
    value: '5900',
    'aria-label': 'Screen sharing port',
  })
  const advancedSettings = el(
    'details',
    { class: 'vnc-advanced' },
    el('summary', {}, 'Advanced'),
    el(
      'label',
      { class: 'vnc-field-label' },
      'Screen sharing port',
      portInput,
      el(
        'span',
        { class: 'vnc-field-hint' },
        'Defaults to 5900. An address ending in :port overrides this value.',
      ),
    ),
  )
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
    'Find screen sharing',
  )
  const discoveryStatus = el(
    'div',
    { class: 'vnc-discovery-status', role: 'status' },
    'Scanning this machine…',
  )
  const discoveredPorts = el('div', {
    class: 'vnc-discovered-ports',
    'aria-label': 'Available shared desktops',
    hidden: true,
  })
  const networkWarning = el(
    'div',
    { class: 'vnc-network-warning', role: 'note', hidden: true },
    'Direct screen sharing is unencrypted. Only connect on a network you trust.',
  )
  const usernameInput = el('input', {
    type: 'text',
    class: 'vnc-auth-input vnc-username-input',
    autocomplete: 'username',
    spellcheck: 'false',
    'aria-label': 'Screen Sharing username',
  })
  const usernameField = el(
    'label',
    { class: 'vnc-field-label vnc-username-field', hidden: true },
    'Username',
    usernameInput,
  )
  const passwordInput = el('input', {
    type: 'password',
    class: 'vnc-auth-input vnc-password-input',
    autocomplete: 'current-password',
    'aria-label': 'Screen Sharing password',
  })
  const passwordField = el(
    'label',
    { class: 'vnc-field-label vnc-password-field', hidden: true },
    'Password',
    passwordInput,
  )
  const targetInput = el('input', {
    type: 'text',
    class: 'vnc-auth-input vnc-target-input',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Screen Sharing authentication target',
  })
  const targetField = el(
    'label',
    { class: 'vnc-field-label vnc-target-field', hidden: true },
    'Target',
    targetInput,
  )
  const authenticateButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary vnc-authenticate-btn' },
    'Authenticate',
  )
  const authDescription = el('div', { class: 'vnc-auth-description' })
  const authPanel = el(
    'div',
    { class: 'vnc-auth-panel', 'aria-label': 'Screen Sharing authentication', hidden: true },
    el('div', { class: 'vnc-auth-title' }, 'Authentication required'),
    authDescription,
    usernameField,
    passwordField,
    targetField,
    authenticateButton,
  )
  const statusTitle = el('div', { class: 'vnc-status-title' }, 'Not connected')
  const statusDetail = el('div', { class: 'vnc-status-detail', hidden: true })
  const status = el('div', { class: 'vnc-status', role: 'status' }, statusTitle, statusDetail)
  const setupFields = el(
    'div',
    { class: 'vnc-setup-fields' },
    el('label', { class: 'vnc-field-label' }, 'Machine', machineSelect),
    nearbyButton,
    nearbyStatus,
    addressField,
    discoverButton,
    discoveryStatus,
    discoveredPorts,
    advancedSettings,
    networkWarning,
  )
  const form = el('div', { class: 'vnc-connect-form' }, setupFields, authPanel, connectButton)
  const note = el(
    'p',
    { class: 'vnc-view-only-note' },
    'Desktop connections are view only. Keyboard and mouse control are off.',
  )
  const controlsBody = el(
    'div',
    { class: 'vnc-controls-body' },
    form,
    status,
    disconnectButton,
    note,
  )
  controlsRoot.append(header, controlsBody)

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
  let sshHostsGeneration = 0
  let sshHosts: SshWorkspaceHost[] = []
  let sshHostResolutions: VncSshHostResolution[] = []
  let allNearbyServers: VncNearbyServer[] = []
  let nearbyServers: VncNearbyServer[] = []
  let displayedMachine = machineSelect.value
  let requiredCredentials = new Set<VncCredentialType>()
  let pendingDisconnectStatus: PendingStatus | null = null
  let connectedAtLeastOnce = false
  let activeTarget: VncTarget | null = null
  let authenticationUsername = ''
  let submittedUsername: string | null = null

  function setSessionUi(active: boolean, connected = false): void {
    controlsRoot.scrollTop = 0
    if (active) controlsBody.scrollTop = 0
    setupFields.hidden = active
    connectButton.hidden = active
    disconnectButton.hidden = !active
    note.hidden = active
    disconnectButton.textContent = connected ? 'Disconnect' : 'Cancel'
    portInput.disabled = active
    addressInput.disabled = active
    machineSelect.disabled = active
    discoverButton.disabled = active
    nearbyButton.disabled = active
    for (const button of discoveredPorts.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = active
    }
    empty.hidden = connected
    screen.hidden = !connected
  }

  function selectedMachineName(): string {
    if (machineSelect.value === LOCAL_MACHINE) return 'this machine'
    if (machineSelect.value === MANUAL_MACHINE) {
      return (
        parseVncEndpoint(addressInput.value, Number.parseInt(portInput.value, 10))?.host ??
        'remote desktop'
      )
    }
    const nearby = selectedNearbyServer()
    if (nearby) return nearby.name
    if (machineSelect.value.startsWith(SSH_MACHINE_PREFIX)) {
      const id = machineSelect.value.slice(SSH_MACHINE_PREFIX.length)
      return sshHosts.find((host) => host.id === id)?.label ?? 'saved machine'
    }
    return 'remote desktop'
  }

  function setStatus(title: string, kind: VncStatusKind, detail = ''): void {
    status.hidden = false
    statusTitle.textContent = title
    statusDetail.textContent = detail
    statusDetail.hidden = detail.length === 0
    status.dataset['kind'] = kind
  }

  function hideAuthentication(): void {
    authPanel.hidden = true
    requiredCredentials = new Set()
    usernameInput.value = ''
    passwordInput.value = ''
    targetInput.value = ''
  }

  function clearViewer(title: string, kind: 'idle' | 'error' = 'idle', detail = ''): void {
    rfb = null
    channel = null
    activeTarget = null
    authenticationUsername = ''
    submittedUsername = null
    connectedAtLeastOnce = false
    pendingDisconnectStatus = null
    hideAuthentication()
    screen.replaceChildren()
    empty.textContent =
      'Choose this machine, a nearby device, another address, or a saved SSH machine.'
    setSessionUi(false)
    setStatus(title, kind, detail)
  }

  function showAuthentication(types: readonly string[]): boolean {
    const unsupported = types.filter((type) => !isVncCredentialType(type))
    if (types.length === 0 || unsupported.length > 0) {
      pendingDisconnectStatus = {
        title: 'Unsupported authentication',
        detail:
          unsupported.length > 0
            ? `This screen-sharing server requested unsupported credentials: ${unsupported.join(', ')}.`
            : 'This screen-sharing server requested credentials without identifying a supported type.',
        kind: 'error',
      }
      return false
    }

    requiredCredentials = new Set(types.filter(isVncCredentialType))
    usernameInput.value = requiredCredentials.has('username') ? authenticationUsername : ''
    usernameField.hidden = !requiredCredentials.has('username')
    passwordField.hidden = !requiredCredentials.has('password')
    targetField.hidden = !requiredCredentials.has('target')
    authDescription.textContent = requiredCredentials.has('username')
      ? 'Enter an allowed account from the remote Mac or screen-sharing server.'
      : 'Enter the Screen Sharing password configured on the remote machine.'
    authPanel.hidden = false
    empty.textContent = 'Enter the requested credentials to continue connecting.'
    setStatus(
      'Authentication required',
      'working',
      requiredCredentials.has('username')
        ? 'Enter the requested account credentials to continue.'
        : 'Enter the separate password configured in Screen Sharing settings.',
    )
    status.hidden = true
    const firstInput =
      requiredCredentials.has('username') && !usernameInput.value
        ? usernameInput
        : requiredCredentials.has('password')
          ? passwordInput
          : targetInput
    queueMicrotask(() => {
      firstInput.focus({ preventScroll: true })
    })
    return true
  }

  function submitCredentials(): void {
    if (!rfb || authPanel.hidden) return
    const credentials: { username?: string; password?: string; target?: string } = {}
    if (requiredCredentials.has('username')) {
      const username = usernameInput.value.trim()
      if (!username) {
        authDescription.textContent = 'Enter an account allowed to share this screen.'
        usernameInput.focus()
        return
      }
      credentials.username = username
      authenticationUsername = username
      submittedUsername = username
    }
    if (requiredCredentials.has('password')) {
      if (!passwordInput.value) {
        authDescription.textContent = 'Enter the Screen Sharing or account password.'
        passwordInput.focus()
        return
      }
      credentials.password = passwordInput.value
    }
    if (requiredCredentials.has('target')) {
      const target = targetInput.value.trim()
      if (!target) {
        authDescription.textContent = 'Enter the requested desktop or session.'
        targetInput.focus()
        return
      }
      credentials.target = target
    }
    authPanel.hidden = true
    rfb.sendCredentials(credentials)
    passwordInput.value = ''
    empty.textContent = 'Signing in to the remote desktop…'
    setStatus('Signing in…', 'working', 'Waiting for the remote machine to verify your details.')
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

  function applyNearbyDedupe(): void {
    nearbyServers = dedupeNearbyVncServers(allNearbyServers, sshHosts, sshHostResolutions)
  }

  function updateNearbyStatus(): void {
    const hiddenBySsh = allNearbyServers.length - nearbyServers.length
    nearbyStatus.dataset['kind'] = nearbyServers.length > 0 ? 'ok' : 'idle'
    if (allNearbyServers.length === 0) {
      nearbyStatus.textContent = 'No nearby desktops found. Use Other address if you know its IP.'
    } else if (nearbyServers.length === 0) {
      nearbyStatus.textContent = 'Nearby desktops are already listed as saved SSH machines.'
    } else {
      const nearby = `${String(nearbyServers.length)} nearby ${nearbyServers.length === 1 ? 'device' : 'devices'} found.`
      nearbyStatus.replaceChildren(el('div', {}, nearby))
      if (hiddenBySsh > 0) {
        nearbyStatus.append(el('div', {}, `${String(hiddenBySsh)} matched to saved SSH.`))
      }
    }
  }

  function preferredMachineAfterDedupe(
    previous: string,
    previousNearby: VncNearbyServer | null,
  ): string {
    if (!previousNearby) return previous
    const matchingNearbyIndex = nearbyServers.findIndex(
      (server) => server.host === previousNearby.host && server.port === previousNearby.port,
    )
    if (matchingNearbyIndex >= 0) return nearbyMachineValue(matchingNearbyIndex)
    const matchingSsh = sshHosts.find(
      (host) =>
        dedupeNearbyVncServers(
          [previousNearby],
          [host],
          sshHostResolutions.filter((resolution) => resolution.hostId === host.id),
        ).length === 0,
    )
    return matchingSsh ? sshMachineValue(matchingSsh.id) : LOCAL_MACHINE
  }

  async function refreshSshHosts(preferred = machineSelect.value): Promise<void> {
    const generation = ++sshHostsGeneration
    const previousNearby = selectedNearbyServer()
    try {
      const [nextHosts, nextResolutions] = await Promise.all([
        api.sshWorkspace.listHosts(),
        api.vnc.resolveSshHosts().catch(() => []),
      ])
      if (generation !== sshHostsGeneration) return
      sshHosts = nextHosts
      sshHostResolutions = nextResolutions
    } catch {
      if (generation !== sshHostsGeneration) return
      sshHosts = []
      sshHostResolutions = []
    }
    applyNearbyDedupe()
    const nextPreferred = preferredMachineAfterDedupe(preferred, previousNearby)
    rebuildMachineOptions(nextPreferred)
    updateMachineUi()
    if (allNearbyServers.length > 0) updateNearbyStatus()
  }

  function updateMachineUi(): void {
    const machine = machineSelect.value
    const machineChanged = machine !== displayedMachine
    displayedMachine = machine
    const network = isNetworkMachine(machine)
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
    } else if (machineChanged) {
      portInput.value = '5900'
    }
  }

  function selectedTarget(port: number): VncTarget | null {
    if (machineSelect.value.startsWith(SSH_MACHINE_PREFIX)) {
      return {
        kind: 'ssh',
        hostId: machineSelect.value.slice(SSH_MACHINE_PREFIX.length),
        remotePort: port,
      }
    }
    if (isNetworkMachine(machineSelect.value)) {
      const endpoint = parseVncEndpoint(addressInput.value, port)
      if (!endpoint) return null
      return {
        kind: 'network',
        host: endpoint.host,
        port: endpoint.port,
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
    discoveredPorts.hidden = ports.length <= 1
    if (ports.length > 1) {
      ports.forEach((port, optionIndex) => {
        const label = discoveredDisplayLabel(port, optionIndex)
        const button = el(
          'button',
          {
            type: 'button',
            class: 'vnc-discovered-port',
            'data-port': String(port),
            'aria-label': `${label}, port ${String(port)}`,
          },
          label,
        )
        button.addEventListener('click', () => {
          chooseDiscoveredPort(port)
        })
        discoveredPorts.append(button)
      })
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
        ? 'Checking this saved machine for screen sharing…'
        : 'Checking this machine for screen sharing…'
    renderDiscoveredPorts([])
    try {
      const ports = await api.vnc.discover(discoveryHost(machineSelect.value))
      if (generation !== discoveryGeneration) return
      renderDiscoveredPorts(ports)
      discoveryStatus.dataset['kind'] = ports.length > 0 ? 'ok' : 'idle'
      discoveryStatus.textContent =
        ports.length === 0
          ? 'Screen sharing wasn’t found automatically. You can still connect using Advanced.'
          : ports.length === 1
            ? 'Screen sharing is available.'
            : `${String(ports.length)} shared desktops found.`
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
    nearbyStatus.textContent = 'Looking for nearby desktops…'
    try {
      const servers = await api.vnc.discoverNearby()
      if (generation !== nearbyGeneration) return
      allNearbyServers = dedupeNearbyVncServers(servers, [])
      applyNearbyDedupe()
      const preferred = preferredMachineAfterDedupe(previous, previousNearby)
      rebuildMachineOptions(preferred)
      updateMachineUi()
      updateNearbyStatus()
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
    const activeProject = store
      .getState()
      .projects.find((project) => project.id === store.getState().activeProjectId)
    const preferred = activeProject?.sshHost ? sshMachineValue(activeProject.sshHost) : previous
    await refreshSshHosts(preferred)
    await Promise.all([discoverSelectedMachine(), discoverNearby()])
  }

  async function connect(): Promise<void> {
    const port = Number.parseInt(portInput.value, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setStatus('Enter a port from 1 to 65535.', 'error')
      return
    }
    const target = selectedTarget(port)
    if (!target) {
      setStatus('Enter an address with a valid port from 1 to 65535.', 'error')
      return
    }
    if (target.kind === 'network') {
      if (!target.host) {
        setStatus('Enter a hostname or IP address.', 'error')
        return
      }
      const confirmed = await showConfirmDialog({
        message: `Connect directly to ${target.host}:${String(target.port)}?`,
        detail:
          'Direct screen sharing does not encrypt the screen or session data. Continue only on a network you trust; use a saved SSH machine when possible.',
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
      let rememberedUsername: string | null = null
      try {
        rememberedUsername = await api.vnc.getUsername(target)
      } catch {
        // A locked/unavailable keychain should not prevent a one-off connection.
      }
      authenticationUsername = preferredVncUsername(target, sshHosts, rememberedUsername)
      submittedUsername = null
      const connection = await api.vnc.open(target)
      if (generation !== connectGeneration) {
        await api.vnc.close(connection.id)
        return
      }
      const nextChannel = new VncIpcChannel(connection.id, api)
      channel = nextChannel
      const nextRfb = new RFB(screen, nextChannel, { shared: true })
      rfb = nextRfb
      activeTarget = target
      connectedAtLeastOnce = false
      pendingDisconnectStatus = null
      const machineName = selectedMachineName()
      empty.textContent = 'Connecting to the remote desktop…'
      setSessionUi(true)
      nextRfb.viewOnly = true
      nextRfb.scaleViewport = true
      nextRfb.clipViewport = false
      nextRfb.resizeSession = false
      nextRfb.background = 'var(--bg-base)'
      nextRfb.addEventListener('connect', () => {
        if (rfb !== nextRfb) return
        connectedAtLeastOnce = true
        hideAuthentication()
        setSessionUi(true, true)
        setStatus(
          `Connected to ${machineName}`,
          'ok',
          'View only — keyboard and mouse control are off.',
        )
        const username = submittedUsername
        if (username) {
          void api.vnc
            .rememberUsername(target, username)
            .then((saved) => {
              if (saved || rfb !== nextRfb) return
              setStatus(
                `Connected to ${machineName}`,
                'ok',
                'View only — keyboard and mouse control are off. The username was not saved because secure storage is unavailable.',
              )
            })
            .catch(() => {
              if (rfb !== nextRfb) return
              setStatus(
                `Connected to ${machineName}`,
                'ok',
                'View only — keyboard and mouse control are off. The username could not be saved securely.',
              )
            })
        }
      })
      nextRfb.addEventListener('disconnect', (event) => {
        if (rfb !== nextRfb) return
        const pending = pendingDisconnectStatus
        if (pending) {
          clearViewer(pending.title, pending.kind === 'error' ? 'error' : 'idle', pending.detail)
          return
        }
        if (event.detail.clean) {
          clearViewer('Disconnected')
          return
        }
        if (!connectedAtLeastOnce) {
          const targetDescription =
            activeTarget?.kind === 'network'
              ? `${activeTarget.host}:${String(activeTarget.port)}`
              : 'the selected desktop'
          clearViewer(
            'Couldn’t connect to the desktop',
            'error',
            `The device at ${targetDescription} answered, but did not finish connecting. Check that Screen Sharing is enabled and allows other viewers.`,
          )
          return
        }
        clearViewer(
          'Desktop connection lost',
          'error',
          'The remote machine closed the session unexpectedly. You can reconnect when it is available.',
        )
      })
      nextRfb.addEventListener('credentialsrequired', (event) => {
        if (rfb !== nextRfb) return
        if (!showAuthentication(event.detail.types)) nextRfb.disconnect()
      })
      nextRfb.addEventListener('securityfailure', (event) => {
        if (rfb !== nextRfb) return
        hideAuthentication()
        const reason = event.detail.reason?.trim()
        pendingDisconnectStatus = {
          title: /too many/i.test(reason ?? '')
            ? 'Too many authentication attempts'
            : 'Authentication failed',
          detail: reason
            ? `Check the Screen Sharing password or allowed macOS account. The remote machine said: ${reason.replace(/VNC/gi, 'Screen Sharing')}`
            : 'Check the Screen Sharing password or allowed macOS account, then try again.',
          kind: 'error',
        }
        setStatus(
          pendingDisconnectStatus.title,
          pendingDisconnectStatus.kind,
          pendingDisconnectStatus.detail,
        )
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
  authenticateButton.addEventListener('click', submitCredentials)
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
  for (const input of [usernameInput, passwordInput, targetInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitCredentials()
    })
  }

  const stopData = api.vnc.onData((connectionId, bytes) => {
    if (channel?.connectionId === connectionId) channel.receive(bytes)
  })
  const stopStatus = api.vnc.onStatus((event) => {
    if (
      channel?.connectionId === event.id &&
      event.status === 'error' &&
      pendingDisconnectStatus === null
    ) {
      pendingDisconnectStatus = {
        title: connectedAtLeastOnce ? 'Desktop connection lost' : 'Desktop connection failed',
        detail: event.lastError ?? 'The desktop connection closed unexpectedly.',
        kind: 'error',
      }
    }
    channel?.handleStatus(event)
  })
  const stopWorkspace = store.on('workspace_changed', () => {
    if (channel) disconnect()
    const activeProject = store
      .getState()
      .projects.find((project) => project.id === store.getState().activeProjectId)
    void refreshSshHosts(
      activeProject?.sshHost ? sshMachineValue(activeProject.sshHost) : machineSelect.value,
    )
  })
  const stopMode = store.on('right_panel_mode_changed', () => {
    if (!vncModeActive(store)) return
    void refreshSshHosts()
    rfb?.focus()
  })
  const stopSettings = store.on('settings_changed', () => {
    void refreshSshHosts()
  })

  setSessionUi(false)
  qsRequired<HTMLInputElement>(form, '.vnc-port-input').value = '5901'
  void loadMachines()

  return () => {
    connectGeneration++
    discoveryGeneration++
    nearbyGeneration++
    sshHostsGeneration++
    rfb?.disconnect()
    channel?.close()
    stopData()
    stopStatus()
    stopWorkspace()
    stopMode()
    stopSettings()
  }
}
