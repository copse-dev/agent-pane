import RFB from '@novnc/novnc'
import { el, qsRequired } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { VncTarget } from '@shared/types/vnc.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { VncIpcChannel } from './vnc-channel.ts'

function vncModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'vnc'
}

function activeTarget(store: AppStore, port: number): VncTarget {
  const state = store.getState()
  const project = state.projects.find((candidate) => candidate.id === state.activeProjectId)
  if (project?.sshHost) {
    return { kind: 'ssh', hostId: project.sshHost, remotePort: port }
  }
  return { kind: 'loopback', port }
}

function targetLabel(store: AppStore): string {
  const state = store.getState()
  const project = state.projects.find((candidate) => candidate.id === state.activeProjectId)
  return project?.sshHost ? `SSH host · ${project.sshHost}` : 'This machine · loopback'
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
  const target = el('div', { class: 'vnc-target-label' }, targetLabel(store))
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
  const status = el('div', { class: 'vnc-status', role: 'status' }, 'Not connected')
  const form = el(
    'div',
    { class: 'vnc-connect-form' },
    el('label', { class: 'vnc-field-label' }, 'RFB port', portInput),
    connectButton,
    disconnectButton,
  )
  const note = el(
    'p',
    { class: 'vnc-view-only-note' },
    'View only. Keyboard, pointer, and clipboard input are disabled.',
  )
  controlsRoot.append(header, el('div', { class: 'vnc-controls-body' }, target, form, status, note))

  const screen = el('div', { class: 'vnc-screen', 'aria-label': 'Remote desktop' })
  const empty = el(
    'div',
    { class: 'panel-empty vnc-empty' },
    'Connect to a loopback VNC server or the active SSH host.',
  )
  viewerRoot.append(screen, empty)

  let rfb: RFB | null = null
  let channel: VncIpcChannel | null = null
  let connectGeneration = 0

  function setConnectedUi(connected: boolean): void {
    connectButton.hidden = connected
    disconnectButton.hidden = !connected
    portInput.disabled = connected
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
      const connection = await api.vnc.open(activeTarget(store, port))
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
        setStatus('This server requires credentials; password support arrives in V2.', 'error')
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
    target.textContent = targetLabel(store)
    if (channel) disconnect()
  })
  const stopProjects = store.on('projects_changed', () => {
    target.textContent = targetLabel(store)
  })
  const stopMode = store.on('right_panel_mode_changed', () => {
    if (vncModeActive(store) && rfb) rfb.focus()
  })

  setConnectedUi(false)
  qsRequired<HTMLInputElement>(form, '.vnc-port-input').value = '5901'

  return () => {
    connectGeneration++
    rfb?.disconnect()
    channel?.close()
    stopData()
    stopStatus()
    stopWorkspace()
    stopProjects()
    stopMode()
  }
}
