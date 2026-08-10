import '../../../tests/setup-dom.ts'
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountPortsSection } from './ports-section.ts'
import { clickActiveConfirmDialogConfirm, mountConfirmDialog } from './confirm-dialog.ts'
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
  rail: HTMLElement
  store: AppStore
  destroy: () => void
}

/** Mount the section with a canned `ports:list`, panel open and Terminal active. */
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
  store.setState({ filesPaneOpen: true, rightPanelMode: 'terminal' })
  const rail = document.createElement('div')
  document.body.append(rail)
  const destroy = mountPortsSection(rail, store, api)
  return { rail, store, destroy }
}

/** The section loads over IPC, so let the microtask queue drain before asserting. */
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

describe('ports section', () => {
  it('lists scanned ports with the owner badge only on rows Copse started', async () => {
    const { rail, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    const rows = rail.querySelectorAll('.ports-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.querySelector('.ports-row-owner')?.textContent, 'Task')
    assert.equal(rows[1]?.querySelector('.ports-row-owner'), null)
  })

  it('expands a row in place, and collapses it again', async () => {
    const { rail, destroy } = mount([OWNED])
    mounts.push(destroy)
    await settle()

    const port = (): HTMLButtonElement =>
      qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]')
    assert.equal(rail.querySelector('.ports-detail'), null)

    port().click()
    assert.ok(rail.querySelector('.ports-detail'))
    assert.equal(port().getAttribute('aria-expanded'), 'true')

    port().click()
    assert.equal(rail.querySelector('.ports-detail'), null)
  })

  it('offers Kill only for an owned port', async () => {
    const { rail, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]').click()
    assert.ok(rail.querySelector('.ports-kill-btn'), 'owned port should offer Kill')

    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="5432"]').click()
    assert.equal(rail.querySelector('.ports-kill-btn'), null)
    assert.match(
      rail.querySelector('.ports-detail-note')?.textContent ?? '',
      /only stops processes it started/,
    )
  })

  it('removes an owned row once main accepts its kill signal', async () => {
    mountConfirmDialog()
    const killed: number[] = []
    const { rail, destroy } = mount([OWNED], {
      kill: (port) => {
        killed.push(port)
        return Promise.resolve({ killed: true })
      },
    })
    mounts.push(destroy)
    await settle()

    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]').click()
    qsRequired<HTMLButtonElement>(rail, '.ports-kill-btn').click()
    clickActiveConfirmDialogConfirm()
    await settle()
    await settle()

    assert.deepEqual(killed, [3000])
    assert.equal(rail.querySelector('.ports-row[data-port="3000"]'), null)
  })

  it('does not let a pre-kill scan restore the removed row', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    mountConfirmDialog()
    let calls = 0
    let releaseStaleScan: ((result: PortScanResult) => void) | undefined
    const staleScan = new Promise<PortScanResult>((resolve) => {
      releaseStaleScan = resolve
    })

    try {
      const { rail, destroy } = mount([], {
        list: () => {
          calls++
          return calls === 1 ? Promise.resolve({ rows: [OWNED], tool: 'lsof' }) : staleScan
        },
        kill: () => Promise.resolve({ killed: true }),
      })
      mounts.push(destroy)
      await settle()
      await settle()
      await settle()

      mock.timers.tick(5_000)
      await settle()
      assert.equal(calls, 2)

      qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]').click()
      qsRequired<HTMLButtonElement>(rail, '.ports-kill-btn').click()
      clickActiveConfirmDialogConfirm()
      await settle()
      await settle()
      assert.equal(rail.querySelector('.ports-row[data-port="3000"]'), null)

      releaseStaleScan?.({ rows: [OWNED], tool: 'lsof' })
      await settle()
      assert.equal(rail.querySelector('.ports-row[data-port="3000"]'), null)
    } finally {
      mock.timers.reset()
    }
  })

  it('offers Open only when the bind address is reachable on loopback', async () => {
    const { rail, destroy } = mount([OWNED, FOREIGN])
    mounts.push(destroy)
    await settle()

    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]').click()
    assert.ok(rail.querySelector('.ports-open-btn'))

    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="5432"]').click()
    assert.equal(rail.querySelector('.ports-open-btn'), null)
  })

  it('opens the port in the browser pane', async () => {
    const { rail, store, destroy } = mount([OWNED])
    mounts.push(destroy)
    await settle()

    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    qsRequired<HTMLButtonElement>(rail, '.ports-row[data-port="3000"]').click()
    qsRequired<HTMLButtonElement>(rail, '.ports-open-btn').click()

    assert.deepEqual(requested, ['http://localhost:3000'])
    assert.equal(store.getState().rightPanelMode, 'browser')
  })

  it('hides itself when a scan ran and found nothing', async () => {
    const { rail, destroy } = mount([])
    mounts.push(destroy)
    await settle()

    // Siblings in this rail hide when empty; an empty Ports header is noise.
    assert.equal(qsRequired(rail, '.ports-section').hidden, true)
  })

  it('stays visible to say it cannot see, rather than claiming nothing is listening', async () => {
    const { rail, destroy } = mount([], { list: () => Promise.resolve({ rows: [], tool: null }) })
    mounts.push(destroy)
    await settle()

    assert.equal(qsRequired(rail, '.ports-section').hidden, false)
    assert.match(
      rail.querySelector('.ports-empty')?.textContent ?? '',
      /No port scanner on this machine/,
    )
  })

  it('scans only while the Terminal pane is on screen', async () => {
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

  it('does not overlap scans when one outlasts the polling interval', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    let release: ((result: PortScanResult) => void) | undefined
    const slowScan = new Promise<PortScanResult>((resolve) => {
      release = resolve
    })
    let calls = 0

    try {
      const { destroy } = mount([], {
        list: () => {
          calls++
          return slowScan
        },
      })
      mounts.push(destroy)
      await settle()
      assert.equal(calls, 1)

      mock.timers.tick(5_000)
      await settle()
      assert.equal(calls, 1, 'a slow scan must not be overlapped by the next poll')
      release?.({ rows: [], tool: 'lsof' })
      await settle()
    } finally {
      mock.timers.reset()
    }
  })
})
