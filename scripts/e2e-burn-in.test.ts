import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import {
  BURN_IN_CAP,
  BURN_IN_LARGE_LABEL,
  BURN_IN_SPEC_ENV,
  OVER_CAP_MATRIX_ENTRY,
  burnInMatrix,
  burnInPassed,
  discoverSpecTests,
  isolatedVerdict,
  overCapMessage,
  parseMarkerRegistry,
  parseNameStatus,
  renderRunSummary,
  reporterCounts,
  restoredSpecs,
  selectBurnInSpecs,
  titleGrep,
  type BurnInResult,
  type FileChange,
  type MarkerEntry,
} from './e2e-burn-in.mts'

const spec = (name: string): string => `tests/e2e/${name}.e2e.ts`
const ci = (...names: string[]): Set<string> => new Set(names.map(spec))
/** `git diff -z --name-status` output: status and paths, NUL-separated. */
const nameStatus = (...entries: string[][]): string => entries.flat().join('\0') + '\0'

function select(
  changes: FileChange[],
  options: {
    base?: MarkerEntry[]
    head?: MarkerEntry[]
    ciSpecs?: Set<string>
    allowLarge?: boolean
  } = {},
): ReturnType<typeof selectBurnInSpecs> {
  return selectBurnInSpecs({
    changes,
    baseRegistry: options.base ?? [],
    headRegistry: options.head ?? [],
    ciSpecs: options.ciSpecs ?? ci('a', 'b', 'c', 'd', 'e', 'f', 'g'),
    allowLarge: options.allowLarge ?? false,
  })
}

describe('burn-in selection', () => {
  it('selects an added spec', () => {
    const selection = select([{ status: 'A', path: spec('a') }])
    assert.equal(selection.status, 'run')
    assert.deepEqual(selection.specs, [{ spec: spec('a'), reasons: ['added'] }])
    assert.deepEqual(burnInMatrix(selection), [spec('a')])
  })

  it('selects a modified spec and the new path of a renamed one', () => {
    const changes = parseNameStatus(
      nameStatus(['M', spec('a')], ['R087', 'tests/e2e/old-name.e2e.ts', spec('b')]),
    )
    assert.deepEqual(select(changes).specs, [
      { spec: spec('a'), reasons: ['modified'] },
      { spec: spec('b'), reasons: ['renamed'] },
    ])
  })

  it('ignores helper-only and fixture changes, and deleted specs', () => {
    const selection = select(
      parseNameStatus(
        nameStatus(
          ['M', 'tests/e2e/helpers/e2e-env.ts'],
          ['A', 'tests/e2e/helpers/new-helper.ts'],
          ['M', 'tests/e2e/fixtures/thread.json'],
          ['M', 'tests/e2e/screenshots/a.png'],
          ['D', spec('c')],
        ),
      ),
    )
    assert.equal(selection.status, 'none')
    assert.deepEqual(selection.specs, [])
    assert.deepEqual(burnInMatrix(selection), [])
  })

  it('selects a nested spec only when the CI suite runs it', () => {
    const nested = 'tests/e2e/scenarios/deep.e2e.ts'
    const changes = [{ status: 'A', path: nested }]
    assert.equal(select(changes).status, 'none')
    assert.deepEqual(burnInMatrix(select(changes, { ciSpecs: new Set([nested]) })), [nested])
  })

  it('selects a spec with an unusual file name rather than dropping it', () => {
    // Tab and newline in a name survive `-z`; `+` is outside the names `run` accepts,
    // so it is selected and then fails the job with a rename hint.
    const odd = ['tests/e2e/send+now.e2e.ts', 'tests/e2e/tab\tname.e2e.ts']
    const changes = parseNameStatus(nameStatus(['A', odd[0] ?? ''], ['M', odd[1] ?? '']))
    assert.deepEqual(
      changes.map((c) => c.path),
      odd,
    )
    assert.deepEqual(burnInMatrix(select(changes, { ciSpecs: new Set(odd) })), odd)
  })

  it('selects a spec restored by removing its exclusion entry', () => {
    const base: MarkerEntry[] = [
      { spec: spec('a'), markers: ['wdio.ci.conf.ts: exclude'] },
      { spec: spec('b'), markers: ['describe.skip'] },
    ]
    const selection = select([], { base, head: [base[1] ?? { spec: '', markers: [] }] })
    assert.deepEqual(selection.specs, [{ spec: spec('a'), reasons: ['restored'] }])
  })

  it('treats dropping one of several markers as a restoration, but not a metadata edit', () => {
    const base: MarkerEntry[] = [{ spec: spec('a'), markers: ['this.skip', 'describe.skip'] }]
    assert.deepEqual(restoredSpecs(base, [{ spec: spec('a'), markers: ['this.skip'] }]), [
      spec('a'),
    ])
    assert.deepEqual(
      restoredSpecs(base, [{ spec: spec('a'), markers: ['describe.skip', 'this.skip'] }]),
      [],
    )
  })

  it('does not burn in a spec the CI suite still excludes, and says why', () => {
    const selection = select([{ status: 'M', path: spec('quarantined') }])
    assert.equal(selection.status, 'none')
    assert.equal(selection.skipped[0]?.spec, spec('quarantined'))
  })

  it('merges the reasons when a restored spec is also edited', () => {
    const selection = select([{ status: 'M', path: spec('a') }], {
      base: [{ spec: spec('a'), markers: ['describe.skip'] }],
    })
    assert.deepEqual(selection.specs, [{ spec: spec('a'), reasons: ['modified', 'restored'] }])
  })

  it(`runs up to the cap of ${String(BURN_IN_CAP)} and fails above it unless labelled`, () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const atCap = select(
      names.slice(0, BURN_IN_CAP).map((name) => ({ status: 'A', path: spec(name) })),
    )
    assert.equal(atCap.status, 'run')
    assert.equal(burnInMatrix(atCap).length, BURN_IN_CAP)

    const over = names.map((name) => ({ status: 'A', path: spec(name) }))
    const refused = select(over)
    assert.equal(refused.status, 'over-cap')
    assert.deepEqual(burnInMatrix(refused), [OVER_CAP_MATRIX_ENTRY])
    assert.match(overCapMessage(refused), new RegExp(BURN_IN_LARGE_LABEL))

    const labelled = select(over, { allowLarge: true })
    assert.equal(labelled.status, 'run')
    assert.equal(burnInMatrix(labelled).length, names.length)
  })

  it('reads a registry with extra or newer fields, and rejects a malformed one', () => {
    assert.deepEqual(
      parseMarkerRegistry(
        JSON.stringify({
          version: 1,
          entries: [{ spec: spec('a'), markers: ['describe.skip'], category: 'quarantine', x: 1 }],
        }),
      ),
      [{ spec: spec('a'), markers: ['describe.skip'] }],
    )
    assert.equal(parseMarkerRegistry('{"entries":[{"spec":1}]}'), null)
    assert.equal(parseMarkerRegistry('not json'), null)
  })
})

describe('burn-in test discovery', () => {
  it('builds Mocha full titles and leaves skipped and dynamic tests out', () => {
    const tests = discoverSpecTests(`
      describe('Outer', () => {
        before(() => {})
        it('first', async () => {})
        it.only(\`second\`, async () => {})
        it.skip('skipped', async () => {})
        describe.skip('Gone', () => { it('never', () => {}) })
        describe('Inner (nested)', function () {
          it("third", () => {})
          for (const n of [1, 2]) it(\`loop \${n}\`, () => {})
        })
      })
      describe(\`Dynamic \${x}\`, () => { it('inside', () => {}) })
      it('top level', () => {})
    `)
    assert.deepEqual(tests.titles, [
      'Outer first',
      'Outer second',
      'Outer Inner (nested) third',
      'top level',
    ])
    assert.equal(tests.dynamic, 2)
  })

  it('keeps the title of a suite chosen at runtime, and drops one always skipped', () => {
    const tests = discoverSpecTests(`
      ;(supported ? describe : describe.skip)('Desktop', function () {
        it('consents', async () => {})
      })
      ;(a ? describe.skip : xdescribe.skip)('Never', () => { it('x', () => {}) })
      ;(slow ? it : it.only)('direct', () => {})
    `)
    assert.deepEqual(tests.titles, ['Desktop consents', 'direct'])
  })

  it('anchors and escapes the grep so one title cannot match another', () => {
    const grep = titleGrep('Panel (a.b) saves $1 / [x]')
    const match = /^\/(.*)\/([a-z]*)$/.exec(grep)
    assert.ok(match?.[1] !== undefined)
    const re = new RegExp(match[1], match[2])
    assert.ok(re.test('Panel (a.b) saves $1 / [x]'))
    assert.ok(!re.test('Panel (a.b) saves $1 / [x] twice'))
    assert.ok(!re.test('Panel (aXb) saves $1 / [x]'))
  })
})

describe('burn-in verdicts', () => {
  it('reads the spec reporter totals', () => {
    assert.deepEqual(
      reporterCounts(
        '[chrome 152.0.7977.167 linux #0-0] 2 passing (3s)\n' +
          '[chrome 152.0.7977.167 linux #0-0] 1 skipped\n' +
          'Spec Files:\t 1 passed, 1 total (100% completed) in 00:00:06',
      ),
      { passing: 2, pending: 1, failing: 0 },
    )
  })

  it('fails an isolated run whose grep matched nothing, which the launcher reports as skipped', () => {
    // WDIO skips a spec with no matching test: the worker exits 0 and only the
    // launcher's summary line mentions it.
    const output = 'Spec Files:\t 0 passed, 1 skipped, 1 total (100% completed) in 00:00:02'
    const counts = reporterCounts(output)
    assert.deepEqual(counts, { passing: 0, pending: 0, failing: 0 })
    assert.equal(isolatedVerdict(0, counts), 'failed')
  })

  it('fails an isolated run that matched no test, and reports a skipped one', () => {
    assert.equal(isolatedVerdict(0, { passing: 1, pending: 0, failing: 0 }), 'passed')
    assert.equal(isolatedVerdict(0, { passing: 0, pending: 1, failing: 0 }), 'skipped')
    assert.equal(isolatedVerdict(0, { passing: 0, pending: 0, failing: 0 }), 'failed')
    assert.equal(isolatedVerdict(1, { passing: 1, pending: 0, failing: 0 }), 'failed')
  })

  it('passes only when every full and isolated run passed, and names the failures', () => {
    const result: BurnInResult = {
      spec: spec('a'),
      repeats: 10,
      fullPassed: 10,
      fullFailures: [],
      isolated: [
        { title: 'Outer first', verdict: 'passed', exitCode: 0 },
        { title: 'Outer second', verdict: 'skipped', exitCode: 0 },
      ],
      dynamicTests: 0,
    }
    assert.ok(burnInPassed(result))
    assert.match(renderRunSummary(result), /\| 10\/10 \| 1\/2 \| 1 \| 0 \|/)

    const flaky: BurnInResult = {
      ...result,
      fullPassed: 9,
      fullFailures: [{ run: 4, exitCode: 1 }],
      isolated: [{ title: 'Outer first', verdict: 'failed', exitCode: 1 }],
    }
    assert.ok(!burnInPassed(flaky))
    const summary = renderRunSummary(flaky)
    assert.match(summary, /FAILED/)
    assert.match(summary, /#4 \(exit 1\)/)
    assert.match(summary, /`Outer first`/)
  })
})

describe('ci.yml burn-in wiring', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
  const jobSchema = z.object({
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    outputs: z.record(z.string(), z.string()).optional(),
    strategy: z.object({ matrix: z.record(z.string(), z.unknown()) }).optional(),
    steps: z.array(
      z.object({
        name: z.string().optional(),
        id: z.string().optional(),
        if: z.string().optional(),
        run: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        with: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  const parsed = z.object({ jobs: z.record(z.string(), jobSchema) }).parse(load(workflow))
  const job = (name: string): z.infer<typeof jobSchema> => {
    const found = parsed.jobs[name]
    assert.ok(found, `expected a ${name} job`)
    return found
  }

  it('plans in precheck on pull requests with the documented override label', () => {
    const precheck = job('precheck')
    const step = precheck.steps.find((s) => s.id === 'burn-in-plan')
    assert.ok(step, 'expected a burn-in-plan step in precheck')
    assert.ok(step.run?.includes('node scripts/e2e-burn-in.mts'))
    assert.equal(step.if, "github.event_name == 'pull_request'")
    assert.ok(step.env?.['ALLOW_LARGE']?.includes(`'${BURN_IN_LARGE_LABEL}'`))
    assert.equal(precheck.outputs?.['burn_in_matrix'], '${{ steps.burn-in-plan.outputs.matrix }}')
    assert.equal(precheck.outputs['burn_in_status'], '${{ steps.burn-in-plan.outputs.status }}')
  })

  it('runs one job per spec on the shared build, refusing an over-cap plan first', () => {
    const burnIn = job('e2e-burn-in')
    assert.deepEqual(burnIn.needs, ['precheck', 'build'])
    assert.match(String(burnIn.strategy?.matrix['spec']), /burn_in_matrix/)
    const [refuse, ...rest] = burnIn.steps
    assert.equal(refuse?.if, `matrix.spec == '${OVER_CAP_MATRIX_ENTRY}'`)
    assert.match(refuse.run ?? '', new RegExp(`\\(${String(BURN_IN_CAP)}\\)`))
    assert.match(refuse.run ?? '', new RegExp(BURN_IN_LARGE_LABEL))
    assert.ok(rest.some((s) => s.with?.['name'] === 'dist-tar'))
    assert.ok(rest.some((s) => s.run?.includes('node scripts/e2e-burn-in.mts run')))
    // Fork code never reaches this job.
    assert.match(burnIn.if ?? '', /head\.repo\.full_name == github\.repository/)
  })

  it('passes the spec in the environment, never on the burn-in command line', () => {
    const step = job('e2e-burn-in').steps.find((s) => s.run?.includes('e2e-burn-in.mts run'))
    assert.ok(step?.run)
    assert.equal(step.env?.[BURN_IN_SPEC_ENV], '${{ matrix.spec }}')
    assert.doesNotMatch(step.run, /--spec/)
  })

  it('gives burn-in the e2e job’s disk headroom, before checkout and before the runs', () => {
    const e2e = job('e2e').steps
    const burnIn = job('e2e-burn-in').steps
    for (const name of [
      'Free disk on a cramped hosted runner',
      'Join disk cleanup and log free space',
    ])
      assert.deepEqual(
        burnIn.find((s) => s.name === name),
        e2e.find((s) => s.name === name),
        `${name} must be the e2e job's step`,
      )
    const at = (predicate: (s: (typeof burnIn)[number]) => boolean): number =>
      burnIn.findIndex(predicate)
    const free = at((s) => s.name === 'Free disk on a cramped hosted runner')
    const join = at((s) => s.name === 'Join disk cleanup and log free space')
    const checkout = at((s) => s.name === undefined && s.with?.['persist-credentials'] === false)
    const runs = at((s) => Boolean(s.run?.includes('e2e-burn-in.mts run')))
    assert.ok(free >= 0 && free < checkout && checkout < join && join < runs)
  })

  it('keeps the over-cap refusal off drafts, like the rest of the heavy tier', () => {
    assert.match(
      job('e2e-burn-in').if ?? '',
      /burn_in_status == 'over-cap' &&\s+\(github\.event\.pull_request\.draft == false \|\|/,
    )
  })

  it('reports one stable `e2e burn-in` result that fails only a required, unpassed burn-in', () => {
    const result = job('e2e-burn-in-result')
    assert.equal(result.if, '${{ always() }}')
    assert.deepEqual(result.needs, ['precheck', 'build', 'e2e-burn-in'])
    const [reject, check] = result.steps
    assert.equal(reject?.if, '${{ cancelled() }}')
    assert.match(reject.run ?? '', /exit 1/)
    assert.equal(check?.if, '${{ !cancelled() }}')
    // Status functions are invalid outside `if:`; GitHub rejects the whole file.
    for (const step of result.steps)
      for (const value of Object.values(step.env ?? {}))
        assert.doesNotMatch(value, /\b(always|cancelled|success|failure)\(\)/)
    const script = check.run
    assert.ok(script)
    const verdict = (env: Record<string, string>): number | null =>
      spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          GITHUB_EVENT_NAME: 'pull_request',
          IS_PR: 'true',
          REQUIRED: 'true',
          PRECHECK_RESULT: 'success',
          STATUS: 'run',
          RESULT: 'success',
          ...env,
        },
      }).status
    assert.equal(verdict({}), 0)
    assert.equal(verdict({ RESULT: 'failure' }), 1)
    assert.equal(verdict({ RESULT: 'skipped' }), 1, 'a planned burn-in that never ran')
    assert.equal(verdict({ RESULT: 'cancelled' }), 1)
    assert.equal(verdict({ STATUS: 'over-cap', RESULT: 'failure' }), 1)
    assert.equal(verdict({ STATUS: 'none', RESULT: 'skipped' }), 0)
    assert.equal(verdict({ STATUS: 'run', REQUIRED: 'false', RESULT: 'skipped' }), 0, 'draft')
    assert.equal(verdict({ IS_PR: 'false', STATUS: '', RESULT: 'skipped' }), 0, 'merge queue')
    assert.equal(verdict({ PRECHECK_RESULT: 'failure', STATUS: '' }), 1)
    assert.equal(verdict({ STATUS: 'bogus' }), 1)
  })

  it('uses status functions only in `if:`, where GitHub accepts them', () => {
    // A status function in a step's `env:` makes GitHub reject the whole
    // workflow file, which no job reports (seen on this PR's 9fa6a4a0).
    for (const [name, definition] of Object.entries(parsed.jobs))
      for (const step of definition.steps)
        for (const value of Object.values(step.env ?? {}))
          assert.doesNotMatch(
            value,
            /\b(always|cancelled|success|failure)\(\)/,
            `${name}: ${value}`,
          )
  })

  it('shares one process reaper between the e2e shards and burn-in', () => {
    assert.ok(job('e2e').steps.some((s) => s.run?.includes('bash scripts/e2e-process-cleanup.sh')))
    assert.match(
      readFileSync(resolve('scripts/e2e-burn-in.mts'), 'utf8'),
      /scripts\/e2e-process-cleanup\.sh/,
    )
  })
})
