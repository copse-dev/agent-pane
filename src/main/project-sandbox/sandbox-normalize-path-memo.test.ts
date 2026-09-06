import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizePathForSandbox } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'

const PATCHED_MODULE = resolve(
  'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js',
)

/**
 * Guards `patches/@anthropic-ai__sandbox-runtime@0.0.74.patch`.
 *
 * The patch memoizes `normalizePathForSandbox`'s `realpathSync` lookups for the
 * duration of one synchronous profile build, removing the ~35% of calls that
 * re-resolve a directory another rule entry already resolved.
 *
 * The memo is deliberately invisible in the return value: `isSymlinkOutsideBoundary`
 * only accepts a resolution that is the path itself, its `/private` canonical form,
 * or a path beneath it, so every other resolution is discarded and the original
 * spelling returned either way. That is the safety property — but it also means a
 * black-box test cannot see the cache. So this file pins the two things that can
 * actually regress: the patch being present at all, and normalization still
 * producing the right answers.
 */
describe('sandbox-runtime normalizePathForSandbox memo (patched)', () => {
  it('is still applied to the installed dependency', () => {
    const source = readFileSync(PATCHED_MODULE, 'utf-8')
    assert.match(
      source,
      /realpathSyncForBuild/,
      'patch missing from node_modules — a version bump likely dropped ' +
        'patches/@anthropic-ai__sandbox-runtime@0.0.74.patch; re-create it against the new version',
    )
    assert.doesNotMatch(
      source,
      /const resolvedPath = fs\.realpathSync\(normalizedPath\)/,
      'patch applied but the non-glob branch still calls fs.realpathSync directly',
    )
    assert.doesNotMatch(
      source,
      /const resolvedBaseDir = fs\.realpathSync\(baseDir\)/,
      'patch applied but the glob branch still calls fs.realpathSync directly',
    )
  })

  it('clears the memo on the microtask after each build', () => {
    const source = readFileSync(PATCHED_MODULE, 'utf-8')
    // The scoping is the security-relevant half: a resolution must never be
    // reused by a later command, or a rule could name a stale symlink target.
    assert.match(source, /queueMicrotask\(\(\) => \{\s*realpathBuildMemo = null;?\s*\}\)/)
  })

  it('normalizes real paths, globs, symlinks and missing paths unchanged', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-normalize-'))
    try {
      const target = join(dir, 'target')
      const link = join(dir, 'link')
      mkdirSync(target)
      symlinkSync(target, link)

      // A sibling symlink broadens scope, so the original spelling is kept.
      assert.equal(normalizePathForSandbox(link), link)
      assert.equal(normalizePathForSandbox(`${link}/**`), `${link}/**`)
      // A plain existing directory resolves to itself.
      assert.equal(normalizePathForSandbox(target), target)
      assert.equal(normalizePathForSandbox(`${target}/**`), `${target}/**`)
      // A missing path cannot be resolved and is returned as-is.
      assert.equal(normalizePathForSandbox(join(dir, 'absent')), join(dir, 'absent'))
      // Repeat calls inside one build agree with the first.
      assert.equal(normalizePathForSandbox(target), target)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips a trailing slash from a non-glob spelling', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-normalize-'))
    try {
      assert.equal(normalizePathForSandbox(`${dir}/`), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
