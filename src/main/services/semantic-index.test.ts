import { cpus } from 'node:os'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSemanticSearchResults,
  gortexCpuLimitEnv,
  parseGortexJson,
  parseVeraJson,
  semanticThreadCap,
  setSemanticBackendForTest,
  setSemanticIndexUpdateRunnerForTest,
  updateSemanticIndex,
} from './semantic-index.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('semantic-index parsing', () => {
  it('parses vera JSON results', () => {
    const stdout = JSON.stringify([
      {
        path: 'src/main/index.ts',
        line: 4,
        snippet: 'app.setName("Copse")',
        score: 0.77,
      },
    ])

    assert.deepEqual(parseVeraJson(stdout, 10), [
      {
        path: 'src/main/index.ts',
        startLine: 4,
        text: 'app.setName("Copse")',
        score: 0.77,
      },
    ])
  })

  it('parses gortex search_symbols JSON results', () => {
    // Shape captured from `gortex call search_symbols --format json` (v0.58.3).
    const stdout = JSON.stringify({
      next_cursor: 'eyJvZmZzZXQiOjV9',
      query_class: 'concept',
      results: [
        {
          absolute_file_path: '/tmp/repo/src/main/services/semantic-index.ts',
          doc: 'Incrementally update the semantic index after workspace file changes.',
          file_path: 'src/main/services/semantic-index.ts',
          id: 'src/main/services/semantic-index.ts::updateSemanticIndex',
          kind: 'function',
          name: 'updateSemanticIndex',
          project_id: 'repo',
          start_line: 247,
          visibility: 'public',
          workspace_id: 'repo',
        },
        {
          absolute_file_path: '/tmp/repo/src/main/services/settings-schema.ts',
          file_path: 'src/main/services/settings-schema.ts',
          id: 'src/main/services/settings-schema.ts::getSettingSchema',
          kind: 'function',
          name: 'getSettingSchema',
          project_id: 'repo',
          start_line: 86,
          visibility: 'public',
          workspace_id: 'repo',
        },
      ],
      total: 31,
      truncated: true,
    })

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      assert.deepEqual(parseGortexJson(stdout, 10), [
        {
          path: 'src/main/services/semantic-index.ts',
          startLine: 247,
          text: 'function updateSemanticIndex — Incrementally update the semantic index after workspace file changes.',
        },
        {
          path: 'src/main/services/settings-schema.ts',
          startLine: 86,
          text: 'function getSettingSchema',
        },
      ])
    } finally {
      restore()
    }
  })

  it('scopes gortex hits to a filter path client-side', () => {
    const stdout = JSON.stringify({
      results: [
        { absolute_file_path: '/tmp/repo/src/main/a.ts', start_line: 1, name: 'a' },
        { absolute_file_path: '/tmp/repo/src/renderer/b.ts', start_line: 2, name: 'b' },
      ],
    })

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      const hits = parseGortexJson(stdout, 10, 'src/main')
      assert.deepEqual(
        hits.map((h) => h.path),
        ['src/main/a.ts'],
      )
    } finally {
      restore()
    }
  })

  it('treats a gortex empty result set (results: null) as no hits', () => {
    const stdout = JSON.stringify({ query_class: 'concept', results: null, total: 0 })
    assert.deepEqual(parseGortexJson(stdout, 10), [])
  })

  it('caps semantic-index threads to keep CPU bounded (#517)', () => {
    const cap = semanticThreadCap()
    const cores = Math.max(1, cpus().length)
    // Never zero/negative, never more than half the cores, never above the ceiling.
    assert.ok(cap >= 1)
    assert.ok(cap <= 4)
    assert.ok(cap <= Math.max(1, Math.floor(cores / 2)))
  })

  it('caps the gortex Go scheduler via GOMAXPROCS (#517)', () => {
    const env = gortexCpuLimitEnv()
    assert.equal(env['GOMAXPROCS'], String(semanticThreadCap()))
  })

  it('coalesces overlapping index updates into one in-flight run plus one trailing run (#517)', async () => {
    setSemanticBackendForTest('gortex')
    let active = 0
    let maxConcurrent = 0
    let runs = 0
    // Each run parks its resolver here so the test can release them one at a time.
    const releases: Array<() => void> = []
    setSemanticIndexUpdateRunnerForTest(async () => {
      runs += 1
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      // Hold the run open until the test releases it, so overlaps are observable.
      await new Promise<void>((res) => releases.push(res))
      active -= 1
    })
    try {
      const root = '/tmp/repo'
      // Five concurrent requests for the same root while a run is held open.
      const calls = [
        updateSemanticIndex(root),
        updateSemanticIndex(root),
        updateSemanticIndex(root),
        updateSemanticIndex(root),
        updateSemanticIndex(root),
      ]
      // Let the first run start and the rest register as pending.
      await new Promise((res) => setTimeout(res, 0))
      // Drain: releasing each held run lets the loop pick up the trailing pass.
      while (releases.length > 0) {
        releases.shift()?.()
        await new Promise((res) => setTimeout(res, 0))
      }
      await Promise.all(calls)

      // Never more than one indexer process at a time...
      assert.equal(maxConcurrent, 1)
      // ...and the burst collapses to one active + one trailing run, not five.
      assert.equal(runs, 2)
    } finally {
      setSemanticIndexUpdateRunnerForTest(null)
      setSemanticBackendForTest(null)
    }
  })

  it('formats semantic hits with backend note', () => {
    setSemanticBackendForTest('gortex')
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
      'gortex',
    )
    assert.match(text, /src\/auth\.ts:10-12/)
    assert.match(text, /native gortex backend/)
  })
})
