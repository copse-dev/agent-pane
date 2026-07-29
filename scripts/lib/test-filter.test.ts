import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeNoMatch,
  matchesFilter,
  selectTestFiles,
  suggestTestFiles,
  testOutputPath,
  unmatchedFilters,
} from './test-filter.mts'

const FILES = [
  'src/main/services/hooks/after-file-edit.test.ts',
  'src/main/services/hooks/copse-adapter.test.ts',
  'src/renderer/views/tool-display.test.ts',
  'src/shared/threads/thread-store.test.ts',
  'packages/agent/src/agent-loop-limits.test.ts',
  'scripts/lib/screenshot-scope.test.ts',
]

describe('matchesFilter', () => {
  it('matches a substring of the repo-relative path', () => {
    assert.equal(matchesFilter('src/shared/threads/thread-store.test.ts', 'thread-store'), true)
    assert.equal(matchesFilter('src/shared/threads/thread-store.test.ts', 'shared/threads'), true)
    assert.equal(matchesFilter('src/shared/threads/thread-store.test.ts', 'renderer'), false)
  })

  it('matches the base name with or without the .test.ts suffix', () => {
    assert.equal(matchesFilter('src/renderer/views/tool-display.test.ts', 'tool-display'), true)
    assert.equal(
      matchesFilter('src/renderer/views/tool-display.test.ts', 'tool-display.test.ts'),
      true,
    )
  })

  it('ignores case so a filter does not have to match the path exactly', () => {
    assert.equal(matchesFilter('src/shared/threads/thread-store.test.ts', 'Thread-Store'), true)
  })

  it('treats a filter containing glob characters as a glob', () => {
    assert.equal(
      matchesFilter('src/main/services/hooks/copse-adapter.test.ts', 'src/main/**'),
      true,
    )
    assert.equal(matchesFilter('src/renderer/views/tool-display.test.ts', 'src/main/**'), false)
    assert.equal(
      matchesFilter('src/renderer/views/tool-display.test.ts', '**/*-display.test.ts'),
      true,
    )
  })

  it('never matches on an empty filter', () => {
    assert.equal(matchesFilter('src/shared/threads/thread-store.test.ts', ''), false)
  })
})

describe('selectTestFiles', () => {
  it('returns the whole suite when no filters are given', () => {
    assert.deepEqual(selectTestFiles(FILES, []), FILES)
  })

  it('unions the matches across filters and keeps the input order', () => {
    assert.deepEqual(selectTestFiles(FILES, ['thread-store', 'hooks/']), [
      'src/main/services/hooks/after-file-edit.test.ts',
      'src/main/services/hooks/copse-adapter.test.ts',
      'src/shared/threads/thread-store.test.ts',
    ])
  })

  it('selects a file only once when several filters match it', () => {
    assert.deepEqual(selectTestFiles(FILES, ['thread-store', 'shared/threads']), [
      'src/shared/threads/thread-store.test.ts',
    ])
  })

  it('reaches tests outside src/ so the filter covers the same suite as a full run', () => {
    assert.deepEqual(selectTestFiles(FILES, ['agent-loop-limits']), [
      'packages/agent/src/agent-loop-limits.test.ts',
    ])
    assert.deepEqual(selectTestFiles(FILES, ['screenshot-scope']), [
      'scripts/lib/screenshot-scope.test.ts',
    ])
  })
})

describe('unmatchedFilters', () => {
  it('reports each filter that selected nothing, not just that some did not', () => {
    assert.deepEqual(unmatchedFilters(FILES, ['thread-store', 'nope', 'also-nope']), [
      'nope',
      'also-nope',
    ])
  })

  it('is empty when every filter matched', () => {
    assert.deepEqual(unmatchedFilters(FILES, ['thread-store', 'hooks/']), [])
  })
})

describe('suggestTestFiles', () => {
  it('suggests files sharing a word with a near-miss filter', () => {
    assert.deepEqual(suggestTestFiles(FILES, 'thread_store_thing'), [
      'src/shared/threads/thread-store.test.ts',
    ])
  })

  it('suggests nothing for a filter made only of words every path contains', () => {
    // Otherwise "test" would suggest the first five files alphabetically —
    // a confident-looking answer carrying no information.
    assert.deepEqual(suggestTestFiles(FILES, 'test'), [])
    assert.deepEqual(suggestTestFiles(FILES, 'src/test'), [])
  })

  it('caps the suggestion list', () => {
    assert.equal(
      suggestTestFiles(FILES, 'adapter-hooks-display-store-agent-screenshot', 2).length,
      2,
    )
  })
})

describe('describeNoMatch', () => {
  it('returns null when every filter matched, so callers can use it as the check', () => {
    assert.equal(describeNoMatch(FILES, ['thread-store']), null)
    assert.equal(describeNoMatch(FILES, []), null)
  })

  it('names the filters that missed and how many files were available', () => {
    const msg = describeNoMatch(FILES, ['thread-store', 'nope'])
    assert.ok(msg !== null)
    assert.match(msg, /no test files match: nope/)
    assert.match(msg, /6 test file\(s\) available/)
    assert.doesNotMatch(msg, /thread-store, nope/)
  })

  it('includes suggestions for a near miss', () => {
    const msg = describeNoMatch(FILES, ['copse_adapter'])
    assert.ok(msg !== null)
    assert.match(msg, /did you mean \(for "copse_adapter"\)\?/)
    assert.match(msg, /src\/main\/services\/hooks\/copse-adapter\.test\.ts/)
  })
})

describe('testOutputPath', () => {
  it('mirrors the source tree under dist-test so a subset lands where a full run put it', () => {
    assert.equal(
      testOutputPath('src/shared/threads/thread-store.test.ts'),
      'dist-test/src/shared/threads/thread-store.test.js',
    )
    assert.equal(
      testOutputPath('packages/agent/src/agent-loop-limits.test.ts'),
      'dist-test/packages/agent/src/agent-loop-limits.test.js',
    )
  })
})
