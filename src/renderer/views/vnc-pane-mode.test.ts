import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountVncPane } from './vnc-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

afterEach(() => {
  document.body.replaceChildren()
})

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('vnc pane mode', () => {
  it('discovers machines when the panel opens on Desktop from the store alone', async () => {
    let viewerChecks = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      settings: {
        ...base['settings'],
        get: async (key) => {
          if (key === 'vncEnabled') viewerChecks++
          return base['settings'].get(key)
        },
      },
    }
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const controls = document.createElement('div')
    const viewer = document.createElement('div')
    document.body.append(controls, viewer)
    const unmount = mountVncPane(controls, viewer, store, api)
    try {
      await settle()
      const atMount = viewerChecks

      store.setState({ rightPanelMode: 'terminal', filesPaneOpen: true })
      await settle()
      assert.equal(viewerChecks, atMount, 'another pane opening does not discover machines')

      store.setState({ rightPanelMode: 'vnc' })
      await settle()
      assert.equal(viewerChecks, atMount + 1)
    } finally {
      unmount()
    }
  })

  it('refreshes SSH machines for the new project when setState alone switches projects', async () => {
    let hostLists = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      sshWorkspace: {
        ...base['sshWorkspace'],
        listHosts: async () => {
          hostLists++
          return [
            { id: 'h1', label: 'Build box', host: 'build.example.com' },
            { id: 'h2', label: 'GPU box', host: 'gpu.example.com' },
          ]
        },
      },
    }
    const store = createStore({
      projects: [
        { id: 'p1', path: '/work/one', name: 'One', sshHost: 'h1' },
        { id: 'p2', path: '/work/two', name: 'Two', sshHost: 'h2' },
      ],
      activeProjectId: 'p1',
      workspaceRoot: '/work/one',
    })
    const controls = document.createElement('div')
    const viewer = document.createElement('div')
    document.body.append(controls, viewer)
    const unmount = mountVncPane(controls, viewer, store, api)
    try {
      await settle()
      const atMount = hostLists
      const machine = controls.querySelector<HTMLSelectElement>('.vnc-machine-select')
      assert.ok(machine)

      store.setState({ activeProjectId: 'p2', workspaceRoot: '/work/two' })
      await settle()
      assert.equal(hostLists, atMount + 1, 'the switch re-reads the saved SSH machines')
      assert.equal(machine.value, 'ssh:h2', 'and preselects the new project’s machine')
    } finally {
      unmount()
    }
  })
})
