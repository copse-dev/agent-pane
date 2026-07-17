import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCachedStore, type BackingStore } from './cached-store.ts'

/** Backing store that counts reads — the surface the O(1) contract is asserted on. */
function countingBacking(seed: Record<string, unknown> = {}): {
  backing: BackingStore
  data: Map<string, unknown>
  reads: () => number
} {
  const data = new Map<string, unknown>(Object.entries(seed))
  let reads = 0
  return {
    backing: {
      get(key): unknown {
        reads += 1
        return data.get(key)
      },
      set(key, value): void {
        data.set(key, value)
      },
      delete(key): void {
        data.delete(key)
      },
    },
    data,
    reads: () => reads,
  }
}

describe('cached-store (storage read-complexity contract)', () => {
  it('reads the backing store at most ONCE per key, no matter how often the key is read', () => {
    // Regression contract for the startup hang: electron-store re-parses the
    // whole multi-MB config.json on every `.get`, and a hot loop (the file-index
    // build resolving the execution target per file) called storageGet thousands
    // of times — O(files) full-file parses. The cache must make backing reads
    // O(1) per key. If someone removes the cache, this fails loudly.
    const { backing, reads } = countingBacking({ projects: [{ id: 'p1' }] })
    const store = createCachedStore(backing)
    for (let i = 0; i < 1000; i++) {
      store.get('projects')
      store.get('activeProjectId')
    }
    assert.equal(reads(), 2, 'expected one backing read per distinct key, not per call')
    assert.equal(store.backingReads(), 2)
  })

  it('a missing key is also cached (absence is not re-checked per call)', () => {
    const { backing, reads } = countingBacking()
    const store = createCachedStore(backing)
    assert.equal(store.get('nope'), undefined)
    assert.equal(store.get('nope'), undefined)
    assert.equal(reads(), 1)
  })

  it('set-then-get round-trips without touching the backing read path', () => {
    const { backing, data, reads } = countingBacking()
    const store = createCachedStore(backing)
    store.set('key', { a: 1 })
    assert.deepEqual(store.get('key'), { a: 1 })
    assert.equal(reads(), 0, 'a written key must be served from cache')
    assert.deepEqual(data.get('key'), { a: 1 }, 'write must reach the backing store')
  })

  it('returns clones: mutating a read result must not poison later reads', () => {
    // electron-store returned a freshly-parsed object per read; callers may
    // mutate their copy. The cache must preserve that isolation.
    const { backing } = countingBacking({ list: [1, 2, 3] })
    const store = createCachedStore(backing)
    const first = store.get('list') as number[]
    first.push(999)
    assert.deepEqual(store.get('list'), [1, 2, 3])
  })

  it('clones on write: mutating the value after set must not alter the cached copy', () => {
    const { backing } = countingBacking()
    const store = createCachedStore(backing)
    const value = { nested: { n: 1 } }
    store.set('key', value)
    value.nested.n = 42
    assert.deepEqual(store.get('key'), { nested: { n: 1 } })
  })

  it('delete evicts the cache so the next read consults the backing store again', () => {
    const { backing, data, reads } = countingBacking({ key: 'old' })
    const store = createCachedStore(backing)
    assert.equal(store.get('key'), 'old')
    store.delete('key')
    assert.equal(data.has('key'), false, 'delete must reach the backing store')
    data.set('key', 'external') // simulate a later external write
    assert.equal(store.get('key'), 'external')
    assert.equal(reads(), 2, 'read-delete-read = two backing reads')
  })
})
