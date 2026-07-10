import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GORTEX_EXCLUDE_PATTERNS, isIgnoredWorkspacePath } from './index-ignore.ts'

describe('index-ignore', () => {
  it('ignores changes under build output, deps, vendor, and dot-dirs', () => {
    for (const path of [
      'node_modules/react/index.js',
      'dist/main/index.js',
      'dist-test/foo.js',
      'dist-types/foo.d.ts',
      'dist-test-iso/foo.js',
      'vendor/gortex/gortex',
      '.git/objects/ab/cdef',
      '.claude/worktrees/cool-kilby/src/x.ts',
    ]) {
      assert.equal(isIgnoredWorkspacePath(path), true, `${path} should be ignored`)
    }
  })

  it('handles Windows-style separators', () => {
    assert.equal(isIgnoredWorkspacePath('node_modules\\react\\index.js'), true)
    assert.equal(isIgnoredWorkspacePath('.git\\HEAD'), true)
  })

  it('does not ignore real source paths', () => {
    for (const path of [
      'src/main/services/search/semantic-index.ts',
      'packages/agent/src/run-subagent.ts',
      'scripts/build.mts',
      'README.md',
      'distributor.ts', // not the dist/ dir
    ]) {
      assert.equal(isIgnoredWorkspacePath(path), false, `${path} should not be ignored`)
    }
  })

  it('excludes the heavy gitignored dirs from the gortex ignore list (#517 follow-up)', () => {
    // gortex does not honor .gitignore, so these must be listed explicitly or a
    // dev checkout's ~3 GB of node_modules/dist/worktrees gets indexed.
    for (const dir of ['node_modules/', 'dist/', 'vendor/', '.git/', '.claude/']) {
      assert.ok(
        GORTEX_EXCLUDE_PATTERNS.includes(dir as (typeof GORTEX_EXCLUDE_PATTERNS)[number]),
        `expected gortex excludes to contain ${dir}`,
      )
    }
  })
})
