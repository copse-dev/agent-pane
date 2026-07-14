import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import { el } from '../dom/helpers.ts'
import { openSettingsDialog } from './settings-dialog.ts'

const BANNER_ID = 'ssh-status-banner'

export interface SshStatusBanner {
  destroy: () => void
}

function activeSshHostId(store: AppStore): string | null {
  const { activeProjectId, projects } = store.getState()
  if (!activeProjectId) return null
  const project = projects.find((p) => p.id === activeProjectId)
  return project?.sshHost ?? null
}

function capabilityWarnings(state: SshConnectionState): string[] {
  const warnings: string[] = []
  const caps = state.capabilities
  if (!caps) return warnings
  if (!caps.rg) warnings.push('ripgrep (rg) not found — search will use grep fallback')
  if (!caps.inotifywait) warnings.push('inotifywait not found — file watching is disabled')
  warnings.push(...caps.warnings)
  return warnings
}

export function mountSshStatusBanner(store: AppStore, api: ApiClient): SshStatusBanner {
  let hostEl: HTMLElement | null = null

  function remove(): void {
    hostEl?.remove()
    hostEl = null
  }

  function renderDisconnected(hostId: string, state: SshConnectionState | undefined): void {
    remove()
    const message =
      state?.status === 'error' && state.lastError
        ? `SSH connection to ${state.target} failed: ${state.lastError}`
        : `SSH connection to ${state?.target ?? hostId} is disconnected.`
    const reconnectBtn = el('button', { type: 'button', class: 'ssh-status-action' }, 'Reconnect')
    reconnectBtn.addEventListener('click', () => {
      void api.sshWorkspace.reconnect(hostId).catch(() => undefined)
    })
    const settingsBtn = el('button', { type: 'button', class: 'ssh-status-action' }, 'SSH settings')
    settingsBtn.addEventListener('click', () => {
      openSettingsDialog('ssh')
    })
    hostEl = el(
      'div',
      { id: BANNER_ID, class: 'ssh-status-banner', role: 'status' },
      el('span', { class: 'ssh-status-icon', 'aria-hidden': 'true' }, '⚡'),
      el('span', { class: 'ssh-status-text' }, message),
      el('span', { class: 'ssh-status-actions' }, reconnectBtn, settingsBtn),
    )
    const titlebar = document.getElementById('titlebar')
    if (titlebar?.parentElement) titlebar.after(hostEl)
    else (document.getElementById('app') ?? document.body).prepend(hostEl)
  }

  function renderWarnings(state: SshConnectionState): void {
    const warnings = capabilityWarnings(state)
    if (warnings.length === 0) {
      remove()
      return
    }
    remove()
    hostEl = el(
      'div',
      { id: BANNER_ID, class: 'ssh-status-banner ssh-status-warn', role: 'status' },
      el('span', { class: 'ssh-status-icon', 'aria-hidden': 'true' }, '⚠'),
      el('span', { class: 'ssh-status-text' }, warnings.join(' · ')),
    )
    const titlebar = document.getElementById('titlebar')
    if (titlebar?.parentElement) titlebar.after(hostEl)
    else (document.getElementById('app') ?? document.body).prepend(hostEl)
  }

  function sync(states: SshConnectionState[]): void {
    void api.settings.get('sshWorkspaceEnabled').then((enabled) => {
      if (enabled !== true) {
        remove()
        return
      }
      const hostId = activeSshHostId(store)
      if (!hostId) {
        remove()
        return
      }
      const state = states.find((s) => s.hostId === hostId)
      if (!state || state.status !== 'connected') {
        renderDisconnected(hostId, state)
        return
      }
      renderWarnings(state)
    })
  }

  const unsubs = [
    store.on('workspace_changed', () => {
      void api.sshWorkspace.getStates().then(sync)
    }),
    store.on('projects_changed', () => {
      void api.sshWorkspace.getStates().then(sync)
    }),
    api.sshWorkspace.onConnectionChanged(sync),
  ]

  void api.sshWorkspace.getStates().then(sync)

  return {
    destroy: (): void => {
      remove()
      unsubs.forEach((u) => {
        u()
      })
    },
  }
}
