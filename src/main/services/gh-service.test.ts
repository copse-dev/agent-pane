import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideForwardEnvToken,
  formatGhPrFiles,
  formatGhPrList,
  formatGhPrView,
  ghEnv,
} from './gh-service.ts'

describe('formatGhPrList', () => {
  it('formats PR rows with branch and author', () => {
    const text = formatGhPrList([
      {
        number: 42,
        title: 'Add feature',
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
        headRefName: 'feature',
        author: { login: 'alice' },
      },
    ])
    assert.match(text, /#42 Add feature — OPEN \(feature\) by alice/)
    assert.match(text, /https:\/\/github\.com\/org\/repo\/pull\/42/)
  })

  it('returns empty message for no PRs', () => {
    assert.equal(formatGhPrList([]), '(no pull requests)')
  })
})

describe('ghEnv', () => {
  it('always sets a PATH', () => {
    const env = ghEnv({ PATH: '/custom/bin' })
    assert.match(env['PATH'] ?? '', /\/custom\/bin/)
  })

  it('always forwards non-token GitHub config vars (host/config dir)', () => {
    const env = ghEnv({
      PATH: '/bin',
      GH_HOST: 'github.example.com',
      GH_CONFIG_DIR: '/tmp/gh',
    })
    assert.equal(env['GH_HOST'], 'github.example.com')
    assert.equal(env['GH_CONFIG_DIR'], '/tmp/gh')
  })

  it('forwards GitHub bearer tokens only when includeTokens is set (#521 fallback)', () => {
    const env = ghEnv(
      { PATH: '/bin', GH_TOKEN: 'gh-tok', GITHUB_TOKEN: 'github-tok' },
      { includeTokens: true },
    )
    assert.equal(env['GH_TOKEN'], 'gh-tok')
    assert.equal(env['GITHUB_TOKEN'], 'github-tok')
  })

  it('blanks (not omits) bearer tokens by default so they cannot shadow gh auth login (#516)', () => {
    // Blanking matters because runGh spawns via runCommand, which merges this env
    // on top of process.env: an omitted key would leak the parent token through and
    // override gh's own config-dir credential. An empty value makes gh ignore it.
    const env = ghEnv({ PATH: '/bin', GH_TOKEN: 'gh-tok', GITHUB_TOKEN: 'github-tok' })
    assert.equal(env['GH_TOKEN'], '')
    assert.equal(env['GITHUB_TOKEN'], '')
  })

  it('leaves token keys absent when none are present and never forwards unrelated secrets', () => {
    const env = ghEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'secret' }, { includeTokens: true })
    assert.ok(!('GH_TOKEN' in env))
    assert.ok(!('GITHUB_TOKEN' in env))
    assert.ok(!('ANTHROPIC_API_KEY' in env))
  })
})

describe('decideForwardEnvToken', () => {
  it('never forwards when no token is present', () => {
    assert.equal(decideForwardEnvToken({ hasToken: false, configAuthWorks: false }), false)
    assert.equal(decideForwardEnvToken({ hasToken: false, configAuthWorks: true }), false)
  })

  it('does NOT forward the env token when gh config-dir auth already works (#516)', () => {
    // A working `gh auth login` credential must win; forwarding a local token here
    // is exactly the regression — a stale/wrong-scope token would shadow it.
    assert.equal(decideForwardEnvToken({ hasToken: true, configAuthWorks: true }), false)
  })

  it('forwards the env token as a fallback when gh has no config-dir auth (#521)', () => {
    assert.equal(decideForwardEnvToken({ hasToken: true, configAuthWorks: false }), true)
  })
})

describe('formatGhPrView', () => {
  it('includes branch, diff stats, and checks', () => {
    const text = formatGhPrView({
      number: 7,
      title: 'Fix bug',
      url: 'https://github.com/org/repo/pull/7',
      state: 'OPEN',
      headRefName: 'fix',
      baseRefName: 'main',
      author: { login: 'bob' },
      mergeable: 'MERGEABLE',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }],
      body: 'Fixes the crash.',
    })
    assert.match(text, /#7 Fix bug/)
    assert.match(text, /Branch: fix → main/)
    assert.match(text, /Files changed: 3/)
    assert.match(text, /Diff: \+10 -2/)
    assert.match(text, /CI: SUCCESS/)
    assert.match(text, /Fixes the crash\./)
  })
})

describe('formatGhPrFiles', () => {
  it('lists each changed file with change type and line counts', () => {
    const text = formatGhPrFiles({
      number: 9,
      title: 'Add memories',
      url: 'https://github.com/org/repo/pull/9',
      changedFiles: 2,
      additions: 120,
      deletions: 4,
      files: [
        {
          path: 'src/main/services/okf-memory-store.ts',
          additions: 100,
          deletions: 0,
          changeType: 'ADDED',
        },
        {
          path: 'src/shared/tools/readonly-tools.ts',
          additions: 20,
          deletions: 4,
          changeType: 'MODIFIED',
        },
      ],
    })
    assert.match(text, /#9 Add memories — 2 files changed/)
    assert.match(text, /added\s+src\/main\/services\/okf-memory-store\.ts \(\+100 -0\)/)
    assert.match(text, /modified\s+src\/shared\/tools\/readonly-tools\.ts \(\+20 -4\)/)
    assert.match(text, /Total: \+120 -4/)
  })

  it('handles a PR with no per-file list', () => {
    const text = formatGhPrFiles({ number: 1, title: 'Empty', changedFiles: 0, files: [] })
    assert.match(text, /#1 Empty — 0 files changed/)
    assert.match(text, /no per-file list/)
  })

  it('singularizes a one-file change', () => {
    const text = formatGhPrFiles({
      number: 2,
      title: 'One',
      changedFiles: 1,
      files: [{ path: 'a.ts', additions: 1, deletions: 1, changeType: 'MODIFIED' }],
    })
    assert.match(text, /— 1 file changed/)
  })
})
