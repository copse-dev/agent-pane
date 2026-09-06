import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanonicalPathCache } from './canonical-path-cache.ts'

/** A resolver that records its calls so the tests can count real syscalls. */
function countingResolver(map: Record<string, string> = {}): {
  resolvePath: (path: string) => string
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    resolvePath: (path: string): string => {
      calls.push(path)
      return map[path] ?? path
    },
  }
}

describe('createCanonicalPathCache', () => {
  it('resolves a path once per TTL window however many times it is asked', () => {
    const { resolvePath, calls } = countingResolver({ '/w/root': '/private/w/root' })
    let clock = 1000
    const canonicalize = createCanonicalPathCache({ ttlMs: 2000, now: () => clock, resolvePath })

    // 10 sandboxed spawns in the same burst, as the trace recorded.
    const results = Array.from({ length: 10 }, () => canonicalize('/w/root'))

    assert.deepEqual(new Set(results), new Set(['/private/w/root']))
    assert.equal(calls.length, 1, 'one syscall for the whole burst')
    clock += 1999
    canonicalize('/w/root')
    assert.equal(calls.length, 1, 'still cached at the edge of the window')
  })

  it('re-resolves once the TTL has elapsed so a changed symlink is picked up', () => {
    const target = { '/w/root': '/first' }
    const { resolvePath, calls } = countingResolver(target)
    let clock = 0
    const canonicalize = createCanonicalPathCache({ ttlMs: 2000, now: () => clock, resolvePath })

    assert.equal(canonicalize('/w/root'), '/first')
    target['/w/root'] = '/second'
    assert.equal(canonicalize('/w/root'), '/first', 'still serving the cached answer')

    clock += 2001
    assert.equal(canonicalize('/w/root'), '/second', 'picks up the new target after the window')
    assert.equal(calls.length, 2)
  })

  it('treats different spellings of one path as the same entry', () => {
    const { resolvePath, calls } = countingResolver()
    const canonicalize = createCanonicalPathCache({ resolvePath })

    canonicalize('/w/root')
    canonicalize('/w/nested/../root')
    canonicalize('/w/root/')

    assert.deepEqual(calls, ['/w/root'], 'resolve() normalises before the lookup')
  })

  it('stays bounded, evicting the entry resolved longest ago', () => {
    const { resolvePath, calls } = countingResolver()
    const canonicalize = createCanonicalPathCache({ maxEntries: 2, resolvePath })

    canonicalize('/a')
    canonicalize('/b')
    canonicalize('/a') // a cache hit: does not re-resolve, does not reorder
    assert.equal(calls.length, 2, 'the hit cost no syscall')

    canonicalize('/c') // over capacity — /a was resolved longest ago, so it goes
    assert.equal(calls.length, 3)
    canonicalize('/b')
    assert.equal(calls.length, 3, '/b is still cached')
    canonicalize('/a')
    assert.equal(calls.length, 4, '/a was evicted and had to be resolved again')
  })

  it('matches uncached realpath on a real symlinked directory', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-canon-'))
    try {
      const real = join(dir, 'real')
      const link = join(dir, 'link')
      mkdirSync(real)
      symlinkSync(real, link)
      const canonicalize = createCanonicalPathCache()

      assert.equal(canonicalize(link), realpathSync.native(link))
      assert.equal(canonicalize(link), realpathSync.native(resolve(link)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the resolved path when the target does not exist', () => {
    const canonicalize = createCanonicalPathCache()
    const missing = join(tmpdir(), 'copse-canon-does-not-exist', 'nested')

    assert.equal(canonicalize(missing), resolve(missing))
  })
})
