import { cpus } from 'node:os'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSemanticSearchResults,
  gortexCpuLimitEnv,
  gortexIndexKillTimeoutMs,
  gortexIndexWaitArg,
  gortexMemLimitEnv,
  isOversizedGortexDaemon,
  isSemanticIndexReady,
  parseGortexJson,
  parseGortexExcludes,
  parseTrackedRepos,
  parseVeraJson,
  reapOversizedGortexDaemon,
  reposToUntrackForActive,
  nextRepoMru,
  gortexConfigNeedsRepair,
  repairGortexConfigYaml,
  repairCorruptGortexConfig,
  gortexStoreMaxBytes,
  gortexStoreNeedsReclaim,
  reclaimBloatedGortexStore,
  semanticThreadCap,
  setSemanticBackendForTest,
  setSemanticIndexReadyForTest,
  setSemanticIndexUpdateRunnerForTest,
  stopGortexDaemon,
  updateSemanticIndex,
} from './semantic-index.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

describe('semantic-index parsing', () => {
  it('parses vera JSON results', async () => {
    const stdout = JSON.stringify([
      {
        path: 'src/main/index.ts',
        line: 4,
        snippet: 'app.setName("Copse")',
        score: 0.77,
      },
    ])

    assert.deepEqual(await parseVeraJson(stdout, 10), [
      {
        path: 'src/main/index.ts',
        startLine: 4,
        text: 'app.setName("Copse")',
        score: 0.77,
      },
    ])
  })

  it('parses gortex search_symbols JSON results', async () => {
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
      assert.deepEqual(await parseGortexJson(stdout, 10), [
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

  it('scopes gortex hits to a filter path client-side', async () => {
    const stdout = JSON.stringify({
      results: [
        { absolute_file_path: '/tmp/repo/src/main/a.ts', start_line: 1, name: 'a' },
        { absolute_file_path: '/tmp/repo/src/renderer/b.ts', start_line: 2, name: 'b' },
      ],
    })

    const restore = setWorkspaceRootForTest('/tmp/repo')
    try {
      const hits = await parseGortexJson(stdout, 10, 'src/main')
      assert.deepEqual(
        hits.map((h) => h.path),
        ['src/main/a.ts'],
      )
    } finally {
      restore()
    }
  })

  it('treats a gortex empty result set (results: null) as no hits', async () => {
    const stdout = JSON.stringify({ query_class: 'concept', results: null, total: 0 })
    assert.deepEqual(await parseGortexJson(stdout, 10), [])
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

  it('keeps the gortex track kill-timeout above the --wait-timeout it asks for (#517)', () => {
    const waitArg = gortexIndexWaitArg()
    const match = /^(\d+)m$/.exec(waitArg)
    assert.ok(match, `expected a gortex minute duration, got ${waitArg}`)
    const waitMs = Number(match[1]) * 60_000
    // gortex v0.60.0 accepts --wait-timeout and ignores it (measured: a 5s
    // request returned after 54.8s), so our kill is the only bound that holds.
    // The margin survives for the day gortex honours the flag: a graceful exit
    // must land inside our budget rather than racing the SIGKILL.
    assert.ok(
      gortexIndexKillTimeoutMs() > waitMs,
      `kill timeout ${String(gortexIndexKillTimeoutMs())}ms must exceed wait ${String(waitMs)}ms`,
    )
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

  it('tracks per-root readiness against resolved paths', () => {
    try {
      assert.equal(isSemanticIndexReady('/tmp/repo'), false)
      setSemanticIndexReadyForTest('/tmp/other/../repo')
      assert.equal(isSemanticIndexReady('/tmp/repo'), true)
      assert.equal(isSemanticIndexReady('/tmp/elsewhere'), false)
    } finally {
      setSemanticIndexReadyForTest(null)
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

describe('gortex daemon scoping + reaping', () => {
  const CONFIG = [
    'repos:',
    '    - path: /Users/me/debugging/jotter',
    '    - path: /Users/me/debugging/agent-pane',
    '    - path: /Users/me/debugging/ddg-workflow',
    'exclude:',
    '    - node_modules/',
    '    - path: /not/a/repo/should/not/parse',
    '', // trailing newline
  ].join('\n')

  it('parses only the repos block from config.yaml, not sibling keys', () => {
    assert.deepEqual(parseTrackedRepos(CONFIG), [
      '/Users/me/debugging/jotter',
      '/Users/me/debugging/agent-pane',
      '/Users/me/debugging/ddg-workflow',
    ])
  })

  it('returns [] for a config with no repos block', () => {
    assert.deepEqual(parseTrackedRepos('exclude:\n    - node_modules/\n'), [])
  })

  it('untracks every repo except the active one (deprioritizes non-active)', () => {
    const tracked = parseTrackedRepos(CONFIG)
    assert.deepEqual(reposToUntrackForActive(tracked, '/Users/me/debugging/agent-pane'), [
      '/Users/me/debugging/jotter',
      '/Users/me/debugging/ddg-workflow',
    ])
  })

  it('keeps recently-used repos inside the MRU window so nothing is stranded', () => {
    const tracked = parseTrackedRepos(CONFIG)
    // Two windows open on agent-pane and jotter: neither may untrack the other,
    // or each file-change burst strands a graph and forces a cold re-index.
    assert.deepEqual(
      reposToUntrackForActive(
        tracked,
        '/Users/me/debugging/agent-pane',
        ['/Users/me/debugging/agent-pane', '/Users/me/debugging/jotter'],
        3,
      ),
      ['/Users/me/debugging/ddg-workflow'],
    )
  })

  it('evicts past the MRU ceiling, counting the active repo against it', () => {
    const tracked = parseTrackedRepos(CONFIG)
    // maxTracked=2 → active + one most-recent; ddg-workflow falls out even
    // though it is in the MRU list.
    assert.deepEqual(
      reposToUntrackForActive(
        tracked,
        '/Users/me/debugging/agent-pane',
        ['/Users/me/debugging/jotter', '/Users/me/debugging/ddg-workflow'],
        2,
      ),
      ['/Users/me/debugging/ddg-workflow'],
    )
  })

  it('promotes the active root to the front of the MRU and dedupes it', () => {
    assert.deepEqual(nextRepoMru(['/a', '/b', '/c'], '/c', 3), ['/c', '/a', '/b'])
    assert.deepEqual(nextRepoMru(['/a', '/b'], '/a/', 3), ['/a', '/b'])
  })

  it('truncates the MRU to the ceiling, keeping at least the active root', () => {
    assert.deepEqual(nextRepoMru(['/a', '/b', '/c'], '/d', 2), ['/d', '/a'])
    assert.deepEqual(nextRepoMru(['/a', '/b'], '/d', 0), ['/d'])
  })

  it('reclaims a store only once it crosses the ceiling', () => {
    const cap = gortexStoreMaxBytes()
    assert.equal(gortexStoreNeedsReclaim(cap), true)
    assert.equal(gortexStoreNeedsReclaim(cap + 1), true)
    assert.equal(gortexStoreNeedsReclaim(cap - 1), false)
    // A healthy working store (a few hundred MB) is never dropped.
    assert.equal(gortexStoreNeedsReclaim(400 * 1024 * 1024), false)
  })

  it('reclaimBloatedGortexStore is best-effort and never throws on the boot path', async () => {
    // Same contract as the reap above: boot awaits this before creating the
    // window, so a missing store / unreadable pidfile must resolve, not throw.
    await assert.doesNotReject(reclaimBloatedGortexStore())
  })

  it('normalizes the active path so a trailing slash still matches', () => {
    const tracked = ['/Users/me/debugging/agent-pane']
    assert.deepEqual(reposToUntrackForActive(tracked, '/Users/me/debugging/agent-pane/'), [])
  })

  it('untracks nothing when the active repo is the only tracked one', () => {
    assert.deepEqual(reposToUntrackForActive(['/Users/me/agent-pane'], '/Users/me/agent-pane'), [])
  })

  it('sets a GOMEMLIMIT ceiling on the daemon env', () => {
    assert.match(gortexMemLimitEnv()['GOMEMLIMIT'] ?? '', /^\d+(GiB|MiB|B)$/)
  })

  it('stopGortexDaemon is a safe no-op when gortex is not the active backend', async () => {
    setSemanticBackendForTest(null)
    // Must resolve without spawning / throwing — the before-quit path awaits this.
    await assert.doesNotReject(stopGortexDaemon())
  })

  it('reaps an oversized gortex process but leaves healthy/unrelated ones', () => {
    const gortexCmd = '/app/dist/resources/gortex/gortex daemon start'
    // Oversized zombie → reap.
    assert.equal(isOversizedGortexDaemon(6000, gortexCmd), true)
    // Healthy scoped daemon under the threshold → keep (reuse its warm index).
    assert.equal(isOversizedGortexDaemon(400, gortexCmd), false)
    // A big process that isn't gortex → never touch it (pid-reuse guard).
    assert.equal(isOversizedGortexDaemon(9000, '/Applications/Foo.app/Foo'), false)
  })

  it('reapOversizedGortexDaemon is best-effort and never throws on the boot path', async () => {
    // Whatever the environment (no pidfile, app not ready, ps missing) it must
    // resolve without throwing — the boot path awaits it before creating the
    // window, so a throw here would crash startup.
    await assert.doesNotReject(reapOversizedGortexDaemon())
  })

  it('flags a torn config.yaml that gortex would reject wholesale', () => {
    // Observed client failure: concurrent writers left a bare `s/` after the
    // exclude list; gortex then ignores repos+excludes entirely.
    const torn = [
      'repos:',
      '    - path: /Users/me/debugging/agent-pane',
      'exclude:',
      '    - node_modules/',
      '    - bench-results/',
      's/',
      '',
    ].join('\n')
    assert.equal(gortexConfigNeedsRepair(torn), true)
    assert.equal(gortexConfigNeedsRepair(CONFIG), false)
    assert.equal(gortexConfigNeedsRepair('exclude:\n    - node_modules/\n'), false)
  })

  it('flags indented garbage that is not a list entry or nested key', () => {
    const torn = ['exclude:', '    - node_modules/', '    s/', ''].join('\n')
    assert.equal(gortexConfigNeedsRepair(torn), true)
  })

  it('repairs a torn config by salvaging repos and excludes', () => {
    const torn = [
      'repos:',
      '    - path: /Users/me/debugging/agent-pane',
      'exclude:',
      '    - node_modules/',
      '    - dist/',
      '    - bench-results/',
      's/',
      '',
    ].join('\n')
    const repaired = repairGortexConfigYaml(torn)
    assert.equal(gortexConfigNeedsRepair(repaired), false)
    assert.deepEqual(parseTrackedRepos(repaired), ['/Users/me/debugging/agent-pane'])
    assert.deepEqual(parseGortexExcludes(repaired), ['node_modules/', 'dist/', 'bench-results/'])
    assert.equal(/^s\/$/m.test(repaired), false)
  })

  it('seeds the static exclude baseline when excludes are unrecoverable', () => {
    const torn = 'repos:\n    - path: /tmp/repo\nbogus\n'
    const repaired = repairGortexConfigYaml(torn)
    assert.equal(gortexConfigNeedsRepair(repaired), false)
    assert.deepEqual(parseTrackedRepos(repaired), ['/tmp/repo'])
    assert.ok(parseGortexExcludes(repaired).includes('node_modules/'))
  })

  it('does not carry a torn config’s duplicate repos and excludes into the rewrite', () => {
    // The concurrent writers that tear the file are the same ones that append
    // an entry twice, so the salvage sees duplicates; the rewrite is what
    // gortex keeps from then on.
    const torn = [
      'repos:',
      '    - path: /tmp/repo',
      '    - path: /tmp/repo',
      'exclude:',
      '    - node_modules/',
      '    - dist/',
      '    - node_modules/',
      's/',
      '',
    ].join('\n')
    const repaired = repairGortexConfigYaml(torn)
    assert.deepEqual(parseTrackedRepos(repaired), ['/tmp/repo'])
    assert.deepEqual(parseGortexExcludes(repaired), ['node_modules/', 'dist/'])
  })

  it('repairCorruptGortexConfig is best-effort and never throws on the boot path', async () => {
    await assert.doesNotReject(repairCorruptGortexConfig())
  })
})
