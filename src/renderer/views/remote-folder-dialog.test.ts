// The remote folder browser opens each host in its start folder: beside its last
// project, else in its home. These tests hold the host's connect to check what the
// dialog lets the user do meanwhile, and count connects when the host is down.
//
// happy-dom has no modal-dialog implementation, so showModal/close are shimmed to
// track open state, as in the other dialog tests.
import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type {
  SshConnectionState,
  SshRemoteDirEntry,
  SshWorkspaceHost,
} from '@shared/types/ssh-workspace.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { openRemoteFolderDialog, type RemoteFolderPick } from './remote-folder-dialog.ts'

function patchDialogs(): void {
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = false
      },
    },
  })
}

interface Held<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function held<T>(): Held<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const HOSTS: SshWorkspaceHost[] = [
  { id: 'a', label: 'Alpha', host: 'alpha.internal' },
  { id: 'b', label: 'Beta', host: 'beta.internal' },
]

function connected(hostId: string, home: string): SshConnectionState[] {
  return [
    {
      hostId,
      status: 'connected',
      label: hostId,
      target: hostId,
      capabilities: {
        os: 'Linux',
        arch: 'x86_64',
        shell: '/bin/sh',
        home,
        git: true,
        rg: true,
        warnings: [],
      },
    },
  ]
}

function folders(path: string, ...names: string[]): SshRemoteDirEntry[] {
  return names.map((name) => ({ name, path: `${path === '/' ? '' : path}/${name}` }))
}

interface Harness {
  api: ApiClient
  connects: string[]
  listings: string[]
}

function stubApi(
  connect: (hostId: string) => Promise<SshConnectionState[]>,
  listDirectory: (hostId: string, path: string) => Promise<SshRemoteDirEntry[]>,
): Harness {
  const connects: string[] = []
  const listings: string[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    sshWorkspace: {
      ...base.sshWorkspace,
      listHosts: () => Promise.resolve(HOSTS),
      connect: (hostId) => {
        connects.push(hostId)
        return connect(hostId)
      },
      listDirectory: (hostId, path) => {
        listings.push(`${hostId}:${path}`)
        return listDirectory(hostId, path)
      },
    },
  }
  return { api, connects, listings }
}

function query<T extends Element>(selector: string, type: { new (): T; prototype: T }): T {
  const found = document.querySelector(`#remote-folder-dialog ${selector}`)
  assert.ok(found instanceof type, `missing ${selector}`)
  return found
}

const openButton = (): HTMLButtonElement => query('.remote-folder-open', window.HTMLButtonElement)
const upButton = (): HTMLButtonElement => query('.remote-folder-up', window.HTMLButtonElement)
const hostSelect = (): HTMLSelectElement => query('.remote-folder-host', window.HTMLSelectElement)
const statusText = (): string => query('.remote-folder-status', window.HTMLElement).textContent
const entryNames = (): string[] =>
  [...document.querySelectorAll('#remote-folder-dialog .remote-folder-entry')].map(
    (entry) => entry.textContent,
  )

/** Lets the dialog's awaited calls settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

function chooseHost(hostId: string): void {
  hostSelect().value = hostId
  hostSelect().dispatchEvent(new window.Event('change'))
}

function cancelDialog(): void {
  query('.remote-folder-cancel', window.HTMLButtonElement).click()
}

describe('openRemoteFolderDialog', () => {
  before(patchDialogs)

  it('keeps Open, Up and the old listing out of reach while the next host connects', async () => {
    const betaConnect = held<SshConnectionState[]>()
    const harness = stubApi(
      (hostId) =>
        hostId === 'a' ? Promise.resolve(connected('a', '/home/a')) : betaConnect.promise,
      (hostId, path) => Promise.resolve(folders(path, hostId === 'a' ? 'alpha-src' : 'beta-src')),
    )
    const picked = openRemoteFolderDialog(harness.api)
    await settle()
    assert.deepEqual(entryNames(), ['alpha-src'])
    assert.equal(openButton().disabled, false)

    chooseHost('b')
    await settle()
    assert.equal(openButton().disabled, true, 'Open waits for the new host')
    assert.equal(upButton().disabled, true, 'Up waits for the new host')
    assert.deepEqual(entryNames(), [], 'the previous host’s folders are gone')
    assert.equal(statusText(), 'Connecting…')

    betaConnect.resolve(connected('b', '/home/b'))
    await settle()
    assert.deepEqual(entryNames(), ['beta-src'])
    openButton().click()
    assert.deepEqual<RemoteFolderPick | null>(await picked, { hostId: 'b', path: '/home/b' })
    assert.deepEqual(harness.connects, ['a', 'b'], 'each host connects once')
  })

  it('lets a later host choice replace a host that is still connecting', async () => {
    const betaConnect = held<SshConnectionState[]>()
    const harness = stubApi(
      (hostId) =>
        hostId === 'a' ? Promise.resolve(connected('a', '/home/a')) : betaConnect.promise,
      (hostId, path) => Promise.resolve(folders(path, hostId === 'a' ? 'alpha-src' : 'beta-src')),
    )
    const picked = openRemoteFolderDialog(harness.api)
    await settle()
    chooseHost('b')
    await settle()
    chooseHost('a')
    await settle()
    assert.deepEqual(entryNames(), ['alpha-src'])

    betaConnect.resolve(connected('b', '/home/b'))
    await settle()
    assert.deepEqual(entryNames(), ['alpha-src'], 'the replaced host draws nothing')
    assert.deepEqual(harness.listings, ['a:/home/a', 'a:/home/a'])
    openButton().click()
    assert.deepEqual<RemoteFolderPick | null>(await picked, { hostId: 'a', path: '/home/a' })
  })

  it('tries an unreachable host once and shows why', async () => {
    const harness = stubApi(
      () => Promise.reject(new Error('Host is down.')),
      () => Promise.resolve([]),
    )
    void openRemoteFolderDialog(harness.api, {
      projects: [{ path: '/srv/work/api', sshHost: 'a' }],
    })
    await settle()
    assert.deepEqual(harness.connects, ['a'])
    assert.deepEqual(harness.listings, [])
    assert.match(statusText(), /Host is down\./)
    cancelDialog()
  })

  it('falls back to / on the same connection when the start folder no longer lists', async () => {
    const harness = stubApi(
      () => Promise.resolve(connected('a', '/home/a')),
      (_hostId, path) =>
        path === '/'
          ? Promise.resolve(folders('/', 'srv'))
          : Promise.reject(new Error('No such folder.')),
    )
    void openRemoteFolderDialog(harness.api, {
      projects: [{ path: '/srv/gone/api', sshHost: 'a' }],
    })
    await settle()
    assert.deepEqual(harness.connects, ['a'])
    assert.deepEqual(harness.listings, ['a:/srv/gone', 'a:/'])
    assert.deepEqual(entryNames(), ['srv'])
    assert.equal(statusText(), '')
    cancelDialog()
  })
})
