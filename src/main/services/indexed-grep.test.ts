import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCodeSearchResults,
  parseGrepStdout,
  parseRipgrepJson,
  setIndexedGrepBackendForTest,
} from './indexed-grep.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('indexed-grep parsing', () => {
  it('parses ripgrep JSON match lines', () => {
    const stdout = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/tmp/repo/src/main.ts' },
          line_number: 12,
          lines: { text: 'export function main() {}\n' },
        },
      }),
    ].join('\n')

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      assert.deepEqual(parseRipgrepJson(stdout, 10), ['src/main.ts:12: export function main() {}'])
    } finally {
      restore()
    }
  })

  it('includes context lines with a "-" separator and caps by match count (#122)', () => {
    const stdout = [
      JSON.stringify({
        type: 'context',
        data: {
          path: { text: '/tmp/repo/src/main.ts' },
          line_number: 11,
          lines: { text: 'before\n' },
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/tmp/repo/src/main.ts' },
          line_number: 12,
          lines: { text: 'export function main() {}\n' },
        },
      }),
      JSON.stringify({
        type: 'context',
        data: {
          path: { text: '/tmp/repo/src/main.ts' },
          line_number: 13,
          lines: { text: 'after\n' },
        },
      }),
    ].join('\n')

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      const lines = parseRipgrepJson(stdout, 5)
      assert.deepEqual(lines, [
        'src/main.ts-11- before',
        'src/main.ts:12: export function main() {}',
        'src/main.ts-13- after',
      ])
      // One match (under the cap of 5) plus two context lines must not register
      // as "truncated" even though there are three output lines total.
      assert.doesNotMatch(formatCodeSearchResults(lines, 5, 'rg'), /Truncated/)
    } finally {
      restore()
    }
  })

  it('parses grep-style stdout lines', () => {
    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      assert.deepEqual(parseGrepStdout('/tmp/repo/src/main.ts:12: hello\n', 10), [
        'src/main.ts:12: hello',
      ])
    } finally {
      restore()
    }
  })

  it('formats empty and truncated results', () => {
    setIndexedGrepBackendForTest('rg')
    assert.equal(formatCodeSearchResults([], 5, 'rg'), 'No matches found.')
    assert.match(formatCodeSearchResults(['a.ts:1: x', 'a.ts:2: y'], 2, 'ig'), /indexed ig backend/)
  })
})

describe('indexed-grep backend selection', () => {
  it('defaults to ripgrep when no indexed backend is forced', () => {
    setIndexedGrepBackendForTest(null)
    assert.equal(formatCodeSearchResults(['a.ts:1: x'], 5, 'rg'), 'a.ts:1: x')
  })
})
