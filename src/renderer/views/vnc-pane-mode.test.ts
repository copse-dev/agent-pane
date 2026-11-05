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
})
