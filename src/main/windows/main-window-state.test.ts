import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAIN_WINDOW_STATE_KEY,
  MainWindowStateRepository,
  browserPaneSessionSchema,
  type MainWindowStateStorage,
} from './main-window-state.ts'
import { MAX_RESTORED_BROWSER_TABS } from '@shared/types/main-window.ts'

function memoryStorage(initial?: unknown): { storage: MainWindowStateStorage; writes: unknown[] } {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set(MAIN_WINDOW_STATE_KEY, initial)
  const writes: unknown[] = []
  return {
    storage: {
      get: (key) => values.get(key),
      set: (key, value): void => {
        values.set(key, structuredClone(value))
        writes.push(structuredClone(value))
      },
    },
    writes,
  }
}

const defaults = {
  activeProjectId: 'project-a',
  activeThreadId: 'thread-a',
  bounds: { width: 1200, height: 800 },
}

describe('MainWindowStateRepository', () => {
  it('migrates legacy navigation into one stable window record', () => {
    const { storage, writes } = memoryStorage()
    const repository = new MainWindowStateRepository(
      storage,
      () => 'window-a',
      () => 42,
    )

    assert.deepEqual(repository.loadOrMigrate(defaults), [
      {
        id: 'window-a',
        ...defaults,
        maximized: false,
        fullscreen: false,
        lastFocusedAt: 42,
      },
    ])
    assert.equal(writes.length, 1)

    const reloaded = new MainWindowStateRepository(
      storage,
      () => 'unexpected',
      () => 99,
    )
    assert.equal(reloaded.loadOrMigrate(defaults)[0]?.id, 'window-a')
  })

  it('preserves independent navigation while updating one window', () => {
    const { storage } = memoryStorage()
    let nextId = 0
    const repository = new MainWindowStateRepository(
      storage,
      () => `window-${String(++nextId)}`,
      () => 1,
    )
    const [first] = repository.loadOrMigrate(defaults)
    assert.ok(first)
    const second = repository.create({
      activeProjectId: 'project-b',
      activeThreadId: 'thread-b',
      bounds: { width: 900, height: 700 },
    })

    repository.update(second.id, { activeThreadId: 'thread-b-2' })

    assert.equal(repository.get(first.id)?.activeThreadId, 'thread-a')
    assert.equal(repository.get(second.id)?.activeThreadId, 'thread-b-2')
  })

  it('falls back safely when persisted data is malformed', () => {
    const { storage } = memoryStorage({ version: 1, windows: [{ id: '../bad' }] })
    const repository = new MainWindowStateRepository(
      storage,
      () => 'window-safe',
      () => 7,
    )

    assert.equal(repository.loadOrMigrate(defaults)[0]?.id, 'window-safe')
  })

  it('rejects duplicate persisted window ids', () => {
    const record = {
      id: 'duplicate',
      ...defaults,
      maximized: false,
      fullscreen: false,
      lastFocusedAt: 1,
    }
    const { storage } = memoryStorage({ version: 1, windows: [record, record] })
    const repository = new MainWindowStateRepository(
      storage,
      () => 'window-safe',
      () => 7,
    )

    assert.deepEqual(
      repository.loadOrMigrate(defaults).map(({ id }) => id),
      ['window-safe'],
    )
  })

  it('removes only the closed window record', () => {
    const { storage } = memoryStorage()
    let nextId = 0
    const repository = new MainWindowStateRepository(
      storage,
      () => `window-${String(++nextId)}`,
      () => 1,
    )
    const [first] = repository.loadOrMigrate(defaults)
    assert.ok(first)
    const second = repository.create(defaults)

    repository.remove(first.id)

    assert.deepEqual(
      repository.list().map(({ id }) => id),
      [second.id],
    )
  })

  it('freeze() finalizes the stored snapshot while in-memory updates continue', () => {
    const { storage, writes } = memoryStorage()
    const repository = new MainWindowStateRepository(
      storage,
      () => 'window-a',
      () => 1,
    )
    const [record] = repository.loadOrMigrate(defaults)
    assert.ok(record)
    const writesBeforeFreeze = writes.length

    repository.freeze()
    repository.update(record.id, { activeProjectId: 'project-b' })
    repository.remove(record.id)

    // Nothing reached storage after the freeze — the e2e harness relies on
    // this so a quitting process cannot overwrite freshly-seeded state…
    assert.equal(writes.length, writesBeforeFreeze)
    // …but the in-memory view still tracks the closing windows.
    assert.deepEqual(repository.list(), [])
  })

  it('round-trips the Browser-pane tabs of a window', () => {
    const { storage } = memoryStorage()
    const repository = new MainWindowStateRepository(
      storage,
      () => 'window-a',
      () => 1,
    )
    const [record] = repository.loadOrMigrate(defaults)
    assert.ok(record)

    repository.update(record.id, {
      browserSession: {
        tabs: [
          { url: 'http://localhost:4173/', label: 'localhost:4173' },
          {
            url: '',
            label: 'Sales Dashboard',
            artefactTitle: 'Sales Dashboard',
            artefactThreadId: 'thread-a',
            artefactProjectId: 'project-a',
          },
        ],
        activeTabIndex: 1,
        paneOpen: true,
      },
    })

    // Read back through a fresh repository: the decoder, not the in-memory
    // snapshot, is what a relaunch actually goes through.
    const reloaded = new MainWindowStateRepository(
      storage,
      () => 'unexpected',
      () => 2,
    )
    const [restored] = reloaded.loadOrMigrate(defaults)
    const session = restored?.browserSession
    assert.ok(session)
    assert.equal(session.paneOpen, true)
    assert.equal(session.activeTabIndex, 1)
    assert.deepEqual(session.tabs[1], {
      url: '',
      label: 'Sales Dashboard',
      artefactTitle: 'Sales Dashboard',
      artefactThreadId: 'thread-a',
      artefactProjectId: 'project-a',
    })
  })

  it('drops a record whose stored tabs are not restorable', () => {
    // One bad tab fails the whole record rather than being silently repaired:
    // the state is a window's own session, and a half-decoded one would restore
    // a pane the user never had.
    for (const tabs of [
      [{ url: `data:text/html,${'x'.repeat(64)}` }],
      [{ url: 'http://localhost/', label: 'x'.repeat(257) }],
      Array.from({ length: MAX_RESTORED_BROWSER_TABS + 1 }, () => ({ url: 'http://localhost/' })),
    ]) {
      const { storage } = memoryStorage({
        version: 1,
        windows: [
          {
            id: 'window-a',
            ...defaults,
            maximized: false,
            fullscreen: false,
            lastFocusedAt: 1,
            browserSession: { tabs, activeTabIndex: 0, paneOpen: true },
          },
        ],
      })
      const repository = new MainWindowStateRepository(
        storage,
        () => 'window-fresh',
        () => 1,
      )
      assert.deepEqual(
        repository.loadOrMigrate(defaults).map(({ id }) => id),
        ['window-fresh'],
      )
    }
  })

  it('refuses a data: URL so page content cannot be stored as a tab address', () => {
    assert.equal(
      browserPaneSessionSchema.safeParse({
        tabs: [{ url: ' data:text/html,<h1>hi</h1>' }],
        activeTabIndex: 0,
        paneOpen: true,
      }).success,
      false,
    )
    assert.equal(
      browserPaneSessionSchema.safeParse({
        tabs: [{ url: 'https://example.com/data:not-a-scheme' }],
        activeTabIndex: 0,
        paneOpen: false,
      }).success,
      true,
    )
  })
})
