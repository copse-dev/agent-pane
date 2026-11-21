import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import { el } from '../dom/helpers.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { selectActiveWorkspace } from '../controller/active-workspace.ts'

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

/**
 * One user-facing line per missing remote capability (plus any probe failures).
 *
 * Open files on an SSH host are watched for outside edits (a streaming watcher,
 * or polling where that cannot run), so the external-edit line appears only
 * when the `sshWatcherMode` setting has turned watching off. Copse's own writes
 * refresh either way.
 */
export function capabilityWarnings(
  state: SshConnectionState,
  options: { watching: boolean } = { watching: true },
): string[] {
  const caps = state.capabilities
  if (!caps) return []
  const warnings: string[] = []
  if (!caps.git) warnings.push('git not found — git pane and backups will not work remotely')
  if (!caps.rg) warnings.push('ripgrep (rg) not found — search will use grep fallback')
  if (!options.watching) {
    warnings.push(
      'edits made outside Copse will not appear in open files — remote file watching is turned off',
    )
  }
  warnings.push(...caps.warnings)
  return warnings
}

/** What the banner says when the active project's host is not connected. */
export function disconnectedMessage(hostId: string, state: SshConnectionState | undefined): string {
  if (state?.status === 'error' && state.lastError) {
    return `SSH connection to ${state.target} failed: ${state.lastError}`
  }
  // A state that exists but is not connected was connected and then dropped:
  // the manager found the link gone. No state means it was never opened.
  if (state?.status === 'disconnected') {
    return `SSH connection to ${state.target} was lost. It reconnects on your next command.`
  }
  return `SSH connection to ${state?.target ?? hostId} is disconnected.`
}

export function mountSshStatusBanner(store: AppStore, api: ApiClient): SshStatusBanner {
  let hostEl: HTMLElement | null = null

  function remove(): void {
    hostEl?.remove()
    hostEl = null
  }

  function renderDisconnected(hostId: string, state: SshConnectionState | undefined): void {
    remove()
    const message = disconnectedMessage(hostId, state)
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
      el('span', { class: 'ssh-status-text' }, message),
      el('span', { class: 'ssh-status-actions' }, reconnectBtn, settingsBtn),
    )
    const titlebar = document.getElementById('titlebar')
    if (titlebar?.parentElement) titlebar.after(hostEl)
    else (document.getElementById('app') ?? document.body).prepend(hostEl)
  }

  function renderWarnings(state: SshConnectionState, watching: boolean): void {
    const warnings = capabilityWarnings(state, { watching })
    if (warnings.length === 0) {
      remove()
      return
    }
    remove()
    hostEl = el(
      'div',
      { id: BANNER_ID, class: 'ssh-status-banner ssh-status-warn', role: 'status' },
      el('span', { class: 'ssh-status-text' }, warnings.join(' · ')),
    )
    const titlebar = document.getElementById('titlebar')
    if (titlebar?.parentElement) titlebar.after(hostEl)
    else (document.getElementById('app') ?? document.body).prepend(hostEl)
  }

  function sync(states: SshConnectionState[]): void {
    void Promise.all([
      api.settings.get('sshWorkspaceEnabled'),
      api.settings.get('sshWatcherMode'),
    ]).then(([enabled, watcherMode]) => {
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
      renderWarnings(state, watcherMode !== 'off')
    })
  }

  const unsubs = [
    selectActiveWorkspace(store, () => {
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
