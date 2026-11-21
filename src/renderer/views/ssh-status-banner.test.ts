import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import {
  capabilityWarnings,
  disconnectedMessage,
  mountSshStatusBanner,
} from './ssh-status-banner.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

const WATCHING_OFF_WARNING =
  'edits made outside Copse will not appear in open files — remote file watching is turned off'

function connectedState(
  overrides: Partial<SshConnectionState['capabilities']> = {},
): SshConnectionState {
  return {
    hostId: 'dev',
    status: 'connected',
    label: 'Dev',
    target: 'ubuntu@dev.example',
    capabilities: {
      os: 'Linux',
      arch: 'x86_64',
      shell: '/bin/bash',
      git: true,
      rg: true,
      warnings: [],
      ...overrides,
    },
  }
}

describe('capabilityWarnings', () => {
  it('emits one line per missing tool, then the probe warnings', () => {
    const warnings = capabilityWarnings(
      connectedState({
        git: false,
        warnings: ['Checking the remote machine failed — remote tools may be unavailable.'],
      }),
    )
    assert.deepEqual(warnings, [
      'git not found — git pane and backups will not work remotely',
      'Checking the remote machine failed — remote tools may be unavailable.',
    ])
  })

  it('says nothing about file watching while the host is being watched', () => {
    assert.deepEqual(capabilityWarnings(connectedState()), [])
    assert.deepEqual(capabilityWarnings(connectedState(), { watching: true }), [])
  })

  it('warns about outside edits only when watching is turned off', () => {
    assert.deepEqual(capabilityWarnings(connectedState(), { watching: false }), [
      WATCHING_OFF_WARNING,
    ])
  })
})

describe('disconnectedMessage', () => {
  const base = { hostId: 'dev', label: 'Dev', target: 'ubuntu@dev.example' }

  it('reports the reason a connect failed', () => {
    assert.equal(
      disconnectedMessage('dev', { ...base, status: 'error', lastError: 'connection refused' }),
      'SSH connection to ubuntu@dev.example failed: connection refused',
    )
  })

  it('says a connection that dropped was lost, and what restores it', () => {
    assert.equal(
      disconnectedMessage('dev', { ...base, status: 'disconnected' }),
      'SSH connection to ubuntu@dev.example was lost. It reconnects on your next command.',
    )
  })

  it('falls back to the host id for a host that was never connected', () => {
    assert.equal(disconnectedMessage('dev', undefined), 'SSH connection to dev is disconnected.')
  })
})

describe('mountSshStatusBanner', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><div id="titlebar"></div></div>'
  })

  it('renders a disconnect banner without a lightning emoji', async () => {
    const store = createStore()
    store.setState({
      projects: [{ id: 'p1', path: '/remote', name: 'remote', sshHost: 'dev' }],
      activeProjectId: 'p1',
    })

    const state: SshConnectionState = {
      hostId: 'dev',
      status: 'error',
      label: 'Dev',
      target: 'ubuntu@dev.example',
      lastError: 'connection refused',
    }

    const api = ((): ApiClient => {
      const base = createFakeApi()
      return {
        ...base,
        settings: {
          ...base['settings'],
          get: async (key: string): Promise<unknown> =>
            key === 'sshWorkspaceEnabled' ? true : null,
        },
        sshWorkspace: {
          ...base['sshWorkspace'],
          getStates: async (): Promise<SshConnectionState[]> => [state],
          onConnectionChanged: (): (() => void) => () => undefined,
          reconnect: async (): Promise<SshConnectionState[]> => [state],
        },
      } satisfies ApiClient
    })()

    const banner = mountSshStatusBanner(store, api)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const el = document.getElementById('ssh-status-banner')
    assert.ok(el)
    const text = el.textContent
    assert.ok(text)
    assert.match(text, /SSH connection to ubuntu@dev\.example failed/)
    assert.doesNotMatch(text, /⚡/)
    assert.equal(el.querySelectorAll('.ssh-status-icon').length, 0)
    banner.destroy()
  })

  it('renders a capability warning banner once, without a warning emoji', async () => {
    const store = createStore()
    store.setState({
      projects: [{ id: 'p1', path: '/remote', name: 'remote', sshHost: 'dev' }],
      activeProjectId: 'p1',
    })

    const state = connectedState()
    let watcherMode = 'off'
    let notify: (states: SshConnectionState[]) => void = () => undefined

    const api = ((): ApiClient => {
      const base = createFakeApi()
      return {
        ...base,
        settings: {
          ...base['settings'],
          get: async (key: string): Promise<unknown> =>
            key === 'sshWorkspaceEnabled' ? true : key === 'sshWatcherMode' ? watcherMode : null,
        },
        sshWorkspace: {
          ...base['sshWorkspace'],
          getStates: async (): Promise<SshConnectionState[]> => [state],
          onConnectionChanged: (listener: (states: SshConnectionState[]) => void): (() => void) => {
            notify = listener
            return () => undefined
          },
          reconnect: async (): Promise<SshConnectionState[]> => [state],
        },
      } satisfies ApiClient
    })()

    const banner = mountSshStatusBanner(store, api)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const el = document.getElementById('ssh-status-banner')
    assert.ok(el)
    const text = el.textContent
    assert.equal(text, WATCHING_OFF_WARNING)
    assert.doesNotMatch(text, /⚠|⚡/)
    assert.equal(el.querySelectorAll('.ssh-status-icon').length, 0)

    // The same healthy host with watching on (the default) has nothing to say.
    watcherMode = 'auto'
    notify([state])
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(document.getElementById('ssh-status-banner'), null)
    banner.destroy()
  })
  it('shows the disconnect banner when setState alone switches to an SSH project', async () => {
    const store = createStore()
    store.setState({
      projects: [
        { id: 'local', path: '/local', name: 'local' },
        { id: 'remote', path: '/remote', name: 'remote', sshHost: 'dev' },
      ],
      activeProjectId: 'local',
    })

    const state: SshConnectionState = {
      hostId: 'dev',
      status: 'disconnected',
      label: 'Dev',
      target: 'ubuntu@dev.example',
    }

    const api = ((): ApiClient => {
      const base = createFakeApi()
      return {
        ...base,
        settings: {
          ...base['settings'],
          get: async (key: string): Promise<unknown> =>
            key === 'sshWorkspaceEnabled' ? true : null,
        },
        sshWorkspace: {
          ...base['sshWorkspace'],
          getStates: async (): Promise<SshConnectionState[]> => [state],
          onConnectionChanged: (): (() => void) => () => undefined,
          reconnect: async (): Promise<SshConnectionState[]> => [state],
        },
      } satisfies ApiClient
    })()

    const banner = mountSshStatusBanner(store, api)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(document.getElementById('ssh-status-banner'), null)

    store.setState({ activeProjectId: 'remote', workspaceRoot: '/remote' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const el = document.getElementById('ssh-status-banner')
    assert.ok(el)
    assert.equal(el.textContent.includes('SSH connection to ubuntu@dev.example was lost.'), true)
    banner.destroy()
  })
})
