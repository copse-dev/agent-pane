import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import { mountSshStatusBanner } from './ssh-status-banner.ts'

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

    let listener: ((states: SshConnectionState[]) => void) | null = null
    const api = {
      settings: {
        get: async (key: string): Promise<unknown> => (key === 'sshWorkspaceEnabled' ? true : null),
      },
      sshWorkspace: {
        getStates: async (): Promise<SshConnectionState[]> => [state],
        onConnectionChanged: (cb: (states: SshConnectionState[]) => void): (() => void) => {
          listener = cb
          return () => {
            listener = null
          }
        },
        reconnect: async (): Promise<void> => undefined,
      },
    } as unknown as ApiClient

    const banner = mountSshStatusBanner(store, api)
    await Promise.resolve()
    listener?.([state])
    await Promise.resolve()

    const el = document.getElementById('ssh-status-banner')
    assert.ok(el)
    assert.match(el.textContent ?? '', /SSH connection to ubuntu@dev\.example failed/)
    assert.doesNotMatch(el.textContent ?? '', /⚡/)
    assert.equal(el.querySelectorAll('.ssh-status-icon').length, 0)
    banner.destroy()
  })
})
