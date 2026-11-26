// Adding a local project offers, once, to trust it. Trust stays off unless the
// user says yes, and re-opening a project already in the list never asks again.
import '../../../tests/setup-dom.ts'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from '../views/confirm-dialog.ts'
import { addProject, resetProjectSwitchStateForTest } from './projects.ts'
import { __resetPersistenceForTest } from './persistence.ts'

async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await new Promise((done) => setTimeout(done, 0))
}

interface TrustState {
  trusted: boolean
  root: string
  trustCalls: boolean[]
}

function untrustedAt(root: string): TrustState {
  return { trusted: false, root, trustCalls: [] }
}

function makeApi(state: TrustState): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    workspace: {
      ...base.workspace,
      open: async () => state.root,
      get: async () => state.root,
      set: async (path) => path,
      isTrusted: async () => state.trusted,
      setTrusted: async (trusted): Promise<never[]> => {
        state.trustCalls.push(trusted)
        state.trusted = trusted
        return []
      },
      unsandboxedProjectHooks: async () => [],
    },
  }
}

const confirmMessage = (): string =>
  document.querySelector('#confirm-dialog .confirm-dialog-message')?.textContent ?? ''

beforeEach(() => {
  document.body.innerHTML = ''
  mountConfirmDialog()
  resetProjectSwitchStateForTest()
  __resetPersistenceForTest()
})

test('offers trust for a newly added project and trusts only on yes', async () => {
  const state = untrustedAt('/new')
  const store = createStore({ projects: [] })
  assert.equal(await addProject(store, makeApi(state)), true)
  await flush()
  assert.equal(confirmMessage(), 'Trust this project?')
  clickActiveConfirmDialogConfirm()
  await flush()
  assert.deepEqual(state.trustCalls, [true])
})

test('declining leaves the project untrusted', async () => {
  const state = untrustedAt('/new')
  await addProject(createStore({ projects: [] }), makeApi(state))
  await flush()
  clickActiveConfirmDialogCancel()
  await flush()
  assert.deepEqual(state.trustCalls, [])
  assert.equal(state.trusted, false)
})

test('does not ask again for a project already in the list', async () => {
  const state = untrustedAt('/known')
  const store = createStore({ projects: [{ id: 'k', path: '/known', name: 'known' }] })
  await addProject(store, makeApi(state))
  await flush()
  assert.equal(confirmMessage(), '')
  assert.deepEqual(state.trustCalls, [])
})

test('does not trust a project the window switched away from while asking', async () => {
  const state = untrustedAt('/new')
  await addProject(createStore({ projects: [] }), makeApi(state))
  await flush()
  state.root = '/other'
  clickActiveConfirmDialogConfirm()
  await flush()
  assert.deepEqual(state.trustCalls, [])
})
