import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { whichSync } from '@anthropic-ai/sandbox-runtime/dist/utils/which.js'

/**
 * Guards `patches/@anthropic-ai__sandbox-runtime@0.0.74.patch`.
 *
 * Upstream `whichSync` forks `/usr/bin/which` through `spawnSync` on every call,
 * and `wrapCommandWithSandboxMacOS` calls it once per sandboxed command — on the
 * Electron main thread, ~10 times a second during an agent turn. The patch
 * memoizes the Node fallback on (binary, PATH).
 *
 * These tests observe the memo through its only externally visible effect: once
 * a binary has been resolved, removing it from disk does not change the answer
 * for the same PATH. If a version bump drops the patch, the first test fails.
 */
describe('sandbox-runtime whichSync memo (patched)', () => {
  function withStubBin<T>(fn: (dir: string, binName: string, binPath: string) => T): T {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-which-'))
    try {
      const binName = `copse-stub-${String(process.pid)}`
      const binPath = join(dir, binName)
      writeFileSync(binPath, '#!/bin/sh\nexit 0\n')
      chmodSync(binPath, 0o755)
      return fn(dir, binName, binPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('does not re-spawn `which` for a binary it has already resolved', () => {
    const originalPath = process.env['PATH']
    try {
      withStubBin((dir, binName, binPath) => {
        process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`
        assert.equal(whichSync(binName), binPath, 'resolves the stub on first call')

        // Remove the binary. An unpatched whichSync re-spawns `which` and gets
        // null; the patched one answers from the memo.
        rmSync(binPath)
        assert.equal(
          whichSync(binName),
          binPath,
          'patch missing: whichSync re-spawned `which` instead of using its memo',
        )
      })
    } finally {
      process.env['PATH'] = originalPath
    }
  })

  it('keys the memo on PATH, so a different PATH resolves again', () => {
    const originalPath = process.env['PATH']
    try {
      withStubBin((dir, binName, binPath) => {
        process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`
        assert.equal(whichSync(binName), binPath)

        // Same binary name, PATH that no longer contains it: a PATH-keyed memo
        // misses and re-resolves rather than serving the previous answer.
        process.env['PATH'] = originalPath ?? ''
        assert.equal(whichSync(binName), null)
      })
    } finally {
      process.env['PATH'] = originalPath
    }
  })

  it('does not cache a failed lookup, so a transient miss cannot become permanent', () => {
    // `whichSync` spawns `which` with `timeout: 1000`, so on a loaded machine it
    // can be killed before answering and return null for a binary that is plainly
    // there. Caching that null would make one timeout permanent for the life of
    // the process and every later sandboxed command would throw "Shell not found
    // in PATH" — which is exactly how this failed e2e `close-confirm` the first
    // time round. A miss must stay retryable.
    const originalPath = process.env['PATH']
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-which-miss-'))
    try {
      const binName = `copse-late-${String(process.pid)}`
      const binPath = join(dir, binName)
      process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`

      assert.equal(whichSync(binName), null, 'not there yet')

      // Same binary name, same PATH — only the filesystem changed.
      writeFileSync(binPath, '#!/bin/sh\nexit 0\n')
      chmodSync(binPath, 0o755)
      assert.equal(
        whichSync(binName),
        binPath,
        'a failed lookup was cached — a single transient `which` timeout would ' +
          'wedge every sandboxed command for the rest of the session',
      )
    } finally {
      process.env['PATH'] = originalPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still resolves a real binary', () => {
    assert.equal(typeof whichSync('sh'), 'string')
  })
})
