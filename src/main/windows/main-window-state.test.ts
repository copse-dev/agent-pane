import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAIN_WINDOW_STATE_KEY,
  MainWindowStateRepository,
  type MainWindowStateStorage,
} from './main-window-state.ts'

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
})
