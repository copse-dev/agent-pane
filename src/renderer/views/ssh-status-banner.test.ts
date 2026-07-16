import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import { capabilityWarnings, mountSshStatusBanner } from './ssh-status-banner.ts'

describe('capabilityWarnings', () => {
  it('emits one line per missing tool and does not duplicate probe copy', () => {
    const warnings = capabilityWarnings({
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
        inotifywait: false,
        warnings: ['`inotifywait` missing — external file edits may not be detected live.'],
      },
    })
    assert.deepEqual(warnings, ['inotifywait not found — file watching is disabled'])
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

    const api = {
      settings: {
        get: async (key: string): Promise<unknown> => (key === 'sshWorkspaceEnabled' ? true : null),
      },
      sshWorkspace: {
        getStates: async (): Promise<SshConnectionState[]> => [state],
        onConnectionChanged: (): (() => void) => () => undefined,
        reconnect: async (): Promise<void> => undefined,
      },
    } as unknown as ApiClient

    const banner = mountSshStatusBanner(store, api)
    await Promise.resolve()
    await Promise.resolve()

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

    const state: SshConnectionState = {
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
        inotifywait: false,
        warnings: [],
      },
    }

    const api = {
      settings: {
        get: async (key: string): Promise<unknown> => (key === 'sshWorkspaceEnabled' ? true : null),
      },
      sshWorkspace: {
        getStates: async (): Promise<SshConnectionState[]> => [state],
        onConnectionChanged: (): (() => void) => () => undefined,
        reconnect: async (): Promise<void> => undefined,
      },
    } as unknown as ApiClient

    const banner = mountSshStatusBanner(store, api)
    await Promise.resolve()
    await Promise.resolve()

    const el = document.getElementById('ssh-status-banner')
    assert.ok(el)
    const text = el.textContent
    assert.equal(text, 'inotifywait not found — file watching is disabled')
    assert.doesNotMatch(text, /⚠|⚡/)
    assert.equal(el.querySelectorAll('.ssh-status-icon').length, 0)
    banner.destroy()
  })
})
