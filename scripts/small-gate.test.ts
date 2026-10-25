import { z } from 'zod'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { computeSmallGate, parseSmokeInventory } from './lib/small-gate.mts'
import {
  type Selection,
  computeSelection,
  listCiSpecs,
  read,
  readShardWeights,
} from './test-oracle.mts'
import { outcomeHooks } from './lib/e2e-outcomes.mts'
import { compareOutcomes, parseGatePlan, parseOutcome } from './lib/gate-evidence.mts'

const localRow = z.object({
  outcome: z.string(),
  attempt: z.number(),
  failureClass: z.string().nullable(),
  durationSeconds: z.number().nullable(),
})
const suite = Array.from({ length: 50 }, (_, i) => `tests/e2e/spec-${String(i)}.e2e.ts`)
const inventory = parseSmokeInventory(
  JSON.stringify({
    version: 1,
    areas: [
      { prefix: 'src/feature/', smoke: [suite[0]] },
      { prefix: 'src/unknown/', smoke: null },
    ],
  }),
)
function selection(files: string[], selected: string[] = [], unmapped: string[] = []): Selection {
  return {
    ...computeSelection([]),
    changed: files,
    selectedE2e: selected,
    unmapped,
    confidence: unmapped.length ? ('low' as const) : ('high' as const),
  }
}
it('adds smoke to affected HIGH, skips docs, and never skips shipped source', () => {
  assert.deepEqual(
    computeSmallGate(selection(['src/a.ts'], [suite[1] ?? '']), suite, inventory, false).specs,
    suite.slice(0, 2),
  )
  assert.equal(computeSmallGate(selection(['docs/a.md']), suite, inventory, false).mode, 'skip')
  assert.equal(computeSmallGate(selection(['src/a.ts']), suite, inventory, false).mode, 'subset')
})
it('LOW expands the entire owned area through the existing oracle', () => {
  const result = computeSmallGate(
    selection(['src/feature/new.ts'], [], ['src/feature/new.ts']),
    suite,
    inventory,
    false,
    (files) => {
      assert.deepEqual(files, ['src/feature/a.ts', 'src/feature/b.ts'])
      return [suite[2] ?? '']
    },
    ['src/feature/a.ts', 'src/feature/b.ts', 'src/other/c.ts'],
  )
  assert.deepEqual(result.specs, [suite[0], suite[2]].sort())
})
it('unknown, null, package, broad, forced and over-half changes retain full', () => {
  for (const path of ['src/unknown/a.ts', 'src/unowned/a.ts', 'packages/pkg/src/a.ts'])
    assert.equal(
      computeSmallGate(selection([path], [], [path]), suite, inventory, false).mode,
      'full',
    )
  assert.equal(computeSmallGate(selection([]), suite, inventory, true).mode, 'full')
  assert.equal(
    computeSmallGate({ ...selection([]), baseUnknown: true }, suite, inventory, false).mode,
    'full',
  )
  assert.equal(
    computeSmallGate({ ...selection([]), broad: true }, suite, inventory, false).mode,
    'full',
  )
  assert.equal(
    computeSmallGate(selection(['src/a.ts'], suite.slice(0, 26)), suite, inventory, false).mode,
    'full',
  )
})
it('all twenty seed specs are live, measured <=15s and outside exclusions', () => {
  const live = listCiSpecs(),
    weights = readShardWeights()
  const inv = parseSmokeInventory(read('tests/e2e/smoke-inventory.json'))
  const specs = [...new Set(inv.areas.flatMap((area) => area.smoke ?? []))]
  assert.equal(specs.length, 20)
  for (const spec of specs) {
    assert(live.includes(spec), spec)
    assert((weights.get(spec) ?? Infinity) <= 15, spec)
    assert(!read('tests/e2e/exclusions.json').includes(`"${spec}"`), spec)
  }
})
it('launcher records running/failed/passed and keeps attempts separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-test-'))
  try {
    const one = outcomeHooks(directory, 1),
      two = outcomeHooks(directory, 2)
    const specs = [resolve('tests/e2e/smoke.e2e.ts')]
    one.start('0-0', specs)
    assert.equal(
      localRow.parse(
        JSON.parse(readFileSync(join(directory, readdirSync(directory)[0] ?? ''), 'utf8')),
      ).outcome,
      'running',
    )
    one.end('0-0', 1, specs)
    two.start('0-0', specs)
    two.end('0-0', 0, specs)
    const rows = readdirSync(directory).map((file) =>
      localRow.parse(JSON.parse(readFileSync(join(directory, file), 'utf8'))),
    )
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['failed', 'passed'],
    )
    assert.deepEqual(
      rows.map((row) => row.attempt),
      [1, 2],
    )
    assert.equal(rows[0]?.failureClass, 'unclassified')
    assert((rows[0].durationSeconds ?? -1) >= 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
const sha = 'a'.repeat(40)
const plan = parseGatePlan(
  JSON.stringify({
    version: 1,
    runId: '1',
    runAttempt: '1',
    commit: sha,
    head: sha,
    actual: { mode: 'full', specs: suite.slice(0, 3), shards: 8 },
    proposed: { mode: 'subset', specs: suite.slice(0, 1), count: 1, shards: 1 },
    estimate: { savedSpecMinutes: 1 },
  }),
)
const outcome = (
  path: string,
  attempt: number,
  status = 'failed',
): ReturnType<typeof parseOutcome> =>
  parseOutcome(
    JSON.stringify({
      version: 1,
      spec: path,
      attempt,
      outcome: status,
      exitCode: 1,
      durationSeconds: 2,
      failureClass: 'unclassified',
      runId: '1',
      runAttempt: '1',
      shard: '1',
      commit: sha,
    }),
  )
it('reports gaps and unknown failures; requires cited real classification plus both failed attempts', () => {
  const path = suite[1] ?? ''
  const rows = [outcome(path, 1), outcome(path, 2)]
  assert.deepEqual(compareOutcomes(plan, rows).missedReal, [])
  assert.deepEqual(compareOutcomes(plan, rows).unclassified, [path])
  assert.equal(compareOutcomes(plan, rows).classificationComplete, false)
  const classified = [
    {
      spec: path,
      classification: 'real' as const,
      evidence: 'https://github.com/copse-dev/agent-pane/pull/1',
    },
  ]
  assert.deepEqual(compareOutcomes(plan, rows, classified).missedReal, [path])
  assert.deepEqual(compareOutcomes(plan, [outcome(path, 1)], classified).missedReal, [])
  assert.deepEqual(
    compareOutcomes(plan, [outcome(path, 1), outcome(path, 2, 'passed')], classified).retriedPass,
    [path],
  )
})
it('rejects malformed and path-injected evidence', () => {
  assert.throws(() => parseOutcome('{}'))
  assert.throws(() => parseSmokeInventory('{"version":2}'))
  assert.throws(() => outcome('../../evil', 1))
})

it('CI only adds advisory captures; existing gate aggregate never consumes shadow outputs', () => {
  const ci = read('.github/workflows/ci.yml')
  const aggregate = ci.slice(ci.indexOf('\n  ci-passed:'))
  assert(!aggregate.includes('shadow'))
  assert(ci.includes('continue-on-error: true\n        uses: actions/upload-artifact'))
  assert(ci.includes('COPSE_E2E_ATTEMPT="$attempt"'))
  assert(read('.github/workflows/publish-gate-evidence.yml').includes("conclusion: 'neutral'"))
  assert(
    read('.github/workflows/publish-gate-evidence.yml').includes('ref: ${{ github.workflow_sha }}'),
  )
})

it('inventory areas cite current oracle reasons and explicitly cover top-level directories', () => {
  const inv = parseSmokeInventory(read('tests/e2e/smoke-inventory.json'))
  for (const parent of ['src/main/services', 'src/renderer/views', 'packages']) {
    for (const name of readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) {
      const prefix = parent + '/' + name + (parent === 'packages' ? '/src/' : '/')
      assert(
        inv.areas.some((area) => area.prefix === prefix),
        prefix,
      )
    }
  }
  const files = [
    ...new Set(
      inv.areas.flatMap((area) =>
        Object.values(area.evidence ?? {}).map(
          (reason) =>
            reason
              .split(' in ')
              .at(-1)
              ?.replace(/^imports /, '') ?? '',
        ),
      ),
    ),
  ]
  const selections = computeSelection(files)
  for (const area of inv.areas)
    for (const spec of area.smoke ?? []) {
      const evidence = area.evidence?.[spec]
      assert(evidence, `${area.prefix}: ${spec} lacks ownership evidence`)
      const path =
        evidence
          .split(' in ')
          .at(-1)
          ?.replace(/^imports /, '') ?? ''
      assert(path.startsWith(area.prefix), evidence)
      assert(selections.e2eReasons.get(spec)?.includes(evidence), evidence)
    }
})

it('reruns never combine outer failures across workflow attempts', () => {
  const path = suite[1] ?? ''
  const classified = [
    {
      spec: path,
      classification: 'real' as const,
      evidence: 'https://github.com/copse-dev/agent-pane/pull/1',
    },
  ]
  const earlier = outcome(path, 1)
  const later = { ...outcome(path, 2), runAttempt: '2' }
  assert.deepEqual(compareOutcomes(plan, [earlier, later], classified).missedReal, [])
  const passed = { ...outcome(path, 1, 'passed'), runAttempt: '2' }
  assert.deepEqual(
    compareOutcomes(plan, [earlier, outcome(path, 2), passed], classified).unclassified,
    [],
  )
})

it('partial workflow reruns cannot reuse older passes as complete current coverage', () => {
  const first = suite[0] ?? '',
    second = suite[1] ?? ''
  const runPlan = { ...plan, actual: { ...plan.actual, specs: [first, second] } }
  const rows = [
    outcome(first, 1, 'passed'),
    outcome(second, 1),
    outcome(second, 2),
    { ...outcome(second, 1, 'passed'), runAttempt: '2' },
  ]
  const partial = compareOutcomes(runPlan, rows, [], 2)
  assert.deepEqual(partial.incomplete, [first])
  assert.equal(partial.classificationComplete, false)
  // A new attempt failing before any worker starts must invalidate all old passes.
  const oldPasses = [outcome(first, 1, 'passed'), outcome(second, 1, 'passed')]
  assert.deepEqual(compareOutcomes(runPlan, oldPasses, [], 2).incomplete, [first, second])
  const complete = compareOutcomes(
    runPlan,
    [...rows, { ...outcome(first, 1, 'passed'), runAttempt: '2' }],
    [],
    2,
  )
  assert.equal(complete.classificationComplete, true)
})

it('release and version-tag pushes keep full shadow coverage even with an empty diff', () => {
  for (const ref of ['refs/heads/release', 'refs/tags/v0.1.0-beta.15', 'refs/heads/main']) {
    execFileSync(process.execPath, ['scripts/small-gate-shadow.mts'], {
      env: {
        ...process.env,
        BASE_SHA: 'HEAD',
        EVENT: 'push',
        GITHUB_REF: ref,
        BASE_REF: '',
        ACTUAL_MODE: 'full',
        STACK_TIP: 'false',
        CI_FULL_LABEL: 'false',
        UPDATE_SCREENSHOTS_LABEL: 'false',
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_ATTEMPT: '1',
        HEAD_SHA: '',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
      },
      stdio: 'pipe',
    })
    const result = parseGatePlan(read('e2e-evidence/plan.json'))
    assert.equal(result.proposed.mode, ref === 'refs/heads/main' ? 'skip' : 'full')
    if (ref !== 'refs/heads/main') assert.deepEqual(result.proposed.specs, listCiSpecs())
  }
})

it('the screenshot drift refresh PR keeps full shadow coverage with its empty diff', () => {
  for (const refresh of ['true', 'false']) {
    execFileSync(process.execPath, ['scripts/small-gate-shadow.mts'], {
      env: {
        ...process.env,
        BASE_SHA: 'HEAD',
        EVENT: 'pull_request',
        GITHUB_REF: 'refs/pull/1/merge',
        BASE_REF: 'main',
        ACTUAL_MODE: refresh === 'true' ? 'full' : 'skip',
        STACK_TIP: 'false',
        CI_FULL_LABEL: 'false',
        UPDATE_SCREENSHOTS_LABEL: 'false',
        SCREENSHOT_REFRESH: refresh,
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_ATTEMPT: '1',
        HEAD_SHA: '',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
      },
      stdio: 'pipe',
    })
    const result = parseGatePlan(read('e2e-evidence/plan.json'))
    assert.equal(result.proposed.mode, refresh === 'true' ? 'full' : 'skip')
  }
})
