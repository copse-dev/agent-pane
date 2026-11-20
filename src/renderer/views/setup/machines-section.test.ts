import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { MachinesState } from '@shared/machines.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createMachinesSection } from './machines-section.ts'

function pairedState(): MachinesState {
  return {
    featureEnabled: true,
    machines: [
      {
        id: 'model-computer',
        name: 'Model computer',
        address: '127.0.0.1:4319',
        status: 'connected',
        detail: 'Connected',
        models: [{ id: 'local-kev', label: 'Local Kev', model: 'kev-fixture', timeoutMs: 5000 }],
      },
    ],
    addresses: [],
    sharing: {
      enabled: false,
      address: '127.0.0.1',
      port: 0,
      profileIds: [],
      listening: false,
      error: null,
    },
    shareableModels: [],
    clients: [],
    secureStorage: true,
  }
}

describe('createMachinesSection in the shared Machines list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders paired machines into the list it is given, without moving it', async () => {
    const fake = createFakeApi()
    const api = {
      classifiers: fake.classifiers,
      machines: { ...fake.machines, state: async (): Promise<MachinesState> => pairedState() },
    }
    const overview = document.createElement('div')
    const shared = document.createElement('div')
    overview.append(shared)
    const section = createMachinesSection(api, { list: shared })
    document.body.append(overview, section.root)
    await section.refresh()

    // Compare identities as booleans: a failing assert on DOM nodes would try to
    // print the whole node graph.
    assert.equal(shared.parentElement === overview, true, 'the shared list stays where it was put')
    assert.equal(
      section.root.querySelector('.machine-row') === null,
      true,
      'no second list of its own',
    )
    const row = shared.querySelector('.machine-row')
    assert.ok(row)
    assert.equal(row.querySelector('h4')?.textContent, 'Model computer')
  })
})
