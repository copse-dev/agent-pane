import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountPortsPane } from './ports-pane.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'

type PortScanResult = Awaited<ReturnType<ApiClient['ports']['list']>>
type PortRow = PortScanResult['rows'][number]

function row(partial: Partial<PortRow> & { port: number }): PortRow {
  return {
    pid: 100,
    command: 'node',
    address: '127.0.0.1',
    owner: null,
    url: `http://localhost:${String(partial.port)}`,
    ...partial,
  }
}

const OWNED: PortRow = row({
  port: 3000,
  owner: { kind: 'background', id: 'task-1', label: 'npm run dev' },
})
const FOREIGN: PortRow = row({ port: 5432, pid: 900, command: 'postgres', url: null })

interface Mounted {
  list: HTMLElement
  viewer: HTMLElement
  store: AppStore
  destroy: () => void
}

/** Mount the pane with a canned `ports:list`, panel open and ports active. */
function mount(rows: PortRow[], overrides: Partial<ApiClient['ports']> = {}): Mounted {
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    ports: {
      ...base.ports,
      list: () => Promise.resolve({ rows, tool: 'lsof' }),
      ...overrides,
    },
  }
  const store = createStore()
  store.setState({ filesPaneOpen: true, rightPanelMode: 'ports' })
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const destroy = mountPortsPane(list, viewer, store, api)
  return { list, viewer, store, destroy }
}

/** The pane loads over IPC, so let the microtask queue drain before asserting. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const mounts: Array<() => void> = []

afterEach(() => {
  mounts.forEach((destroy) => {
    destroy()
  })
  mounts.length = 0
  document.body.replaceChildren()
})

describe('ports pane', () => {
  it('lists scanned ports with the owner badge only on rows Copse started', async () => {
    const { list, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    const rows = list.querySelectorAll('.ports-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.querySelector('.ports-row-owner')?.textContent, 'Task')
    assert.equal(rows[1]?.querySelector('.ports-row-owner'), null)
  })

  it('offers Kill only for an owned port', async () => {
    const { list, viewer, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    qsRequired<HTMLButtonElement>(list, '.ports-row[data-port="3000"]').click()
    assert.ok(viewer.querySelector('.ports-kill-btn'), 'owned port should offer Kill')

    qsRequired<HTMLButtonElement>(list, '.ports-row[data-port="5432"]').click()
    assert.equal(viewer.querySelector('.ports-kill-btn'), null)
    assert.match(
      viewer.querySelector('.ports-detail-note')?.textContent ?? '',
      /only stops processes it started/,
    )
  })

  it('offers Open only when the bind address is reachable on loopback', async () => {
    const { list, viewer, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    qsRequired<HTMLButtonElement>(list, '.ports-row[data-port="3000"]').click()
    assert.ok(viewer.querySelector('.ports-open-btn'))

    qsRequired<HTMLButtonElement>(list, '.ports-row[data-port="5432"]').click()
    assert.equal(viewer.querySelector('.ports-open-btn'), null)
  })

  it('opens the port in the browser pane', async () => {
    const { list, viewer, store, destroy } = mount([OWNED])
    mounts.push(destroy)
    await settle()

    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    qsRequired<HTMLButtonElement>(list, '.ports-row[data-port="3000"]').click()
    qsRequired<HTMLButtonElement>(viewer, '.ports-open-btn').click()

    assert.deepEqual(requested, ['http://localhost:3000'])
    assert.equal(store.getState().rightPanelMode, 'browser')
  })

  it('shows an empty state rather than a bare list when nothing is listening', async () => {
    const { list, destroy } = mount([])
    mounts.push(destroy)
    await settle()

    assert.match(list.querySelector('.ports-list-empty')?.textContent ?? '', /Nothing is listening/)
  })

  it('says it cannot see rather than claiming nothing is listening', async () => {
    const { list, destroy } = mount([], { list: () => Promise.resolve({ rows: [], tool: null }) })
    mounts.push(destroy)
    await settle()

    assert.match(
      list.querySelector('.ports-list-empty')?.textContent ?? '',
      /No port scanner on this machine/,
    )
  })

  it('stops scanning once the pane is no longer the active mode', async () => {
    let calls = 0
    const { store, destroy } = mount([], {
      list: () => {
        calls++
        return Promise.resolve({ rows: [], tool: 'lsof' })
      },
    })
    mounts.push(destroy)
    await settle()
    assert.equal(calls, 1)

    store.setState({ rightPanelMode: 'explorer' })
    store.emit('right_panel_mode_changed')
    await settle()
    // Leaving the pane must not trigger another scan; each one spawns subprocesses.
    assert.equal(calls, 1)
  })
})
