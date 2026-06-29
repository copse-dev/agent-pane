import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatGhPrFiles, formatGhPrList, formatGhPrView } from './gh-service.ts'

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
