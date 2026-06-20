import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSemanticSearchResults,
  parseCodesearchJson,
  parseVeraJson,
  resolveSemanticSearchRoot,
  setSemanticBackendForTest,
} from './semantic-index.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('semantic-index parsing', () => {
  it('parses codesearch JSON results', () => {
    const stdout = JSON.stringify({
      results: [
        {
          path: '/tmp/repo/src/auth.ts',
          start_line: 10,
          end_line: 18,
          snippet: 'export function authenticate() {}',
          score: 0.912,
        },
      ],
    })

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      assert.deepEqual(parseCodesearchJson(stdout, 10), [
        {
          path: 'src/auth.ts',
          startLine: 10,
          endLine: 18,
          text: 'export function authenticate() {}',
          score: 0.912,
        },
      ])
    } finally {
      restore()
    }
  })

  it('parses vera JSON results', () => {
    const stdout = JSON.stringify([
      {
        path: 'src/main/index.ts',
        line: 4,
        snippet: 'app.setName("agent-pane")',
        score: 0.77,
      },
    ])

    assert.deepEqual(parseVeraJson(stdout, 10), [
      {
        path: 'src/main/index.ts',
        startLine: 4,
        text: 'app.setName("agent-pane")',
        score: 0.77,
      },
    ])
  })

  it('parses codesearch content field from CLI JSON', () => {
    const stdout = JSON.stringify({
      results: [
        {
          path: '/tmp/repo/src/main/services/semantic-index.ts',
          start_line: 146,
          end_line: 165,
          content: 'export async function searchSemanticContent() {}',
          score: 0.048,
        },
      ],
    })

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      assert.deepEqual(parseCodesearchJson(stdout, 10), [
        {
          path: 'src/main/services/semantic-index.ts',
          startLine: 146,
          endLine: 165,
          text: 'export async function searchSemanticContent() {}',
          score: 0.048,
        },
      ])
    } finally {
      restore()
    }
  })

  it('resolveSemanticSearchRoot handles workspace root scope', () => {
    const root = '/tmp/repo'
    assert.equal(resolveSemanticSearchRoot(root), root)
    assert.equal(resolveSemanticSearchRoot(root, '.'), root)
    assert.equal(resolveSemanticSearchRoot(root, 'src/main'), `${root}/src/main`)
    assert.equal(resolveSemanticSearchRoot(root, root), root)
    assert.equal(resolveSemanticSearchRoot(root, `${root}/src`), `${root}/src`)
  })

  it('formats semantic hits with backend note', () => {
    setSemanticBackendForTest('codesearch')
    const text = formatSemanticSearchResults(
      [
        {
          path: 'src/auth.ts',
          startLine: 10,
          endLine: 12,
          text: 'export function authenticate() {}',
          score: 0.5,
        },
      ],
      5,
      'codesearch',
    )
    assert.match(text, /src\/auth\.ts:10-12/)
    assert.match(text, /native codesearch backend/)
  })
})
