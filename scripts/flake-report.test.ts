import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { passedOnRetry, type SpecOutcome } from './lib/gate-evidence.mts'
import {
  aggregate,
  cell,
  classifyAttempts,
  escapeCommandData,
  escapeCommandProperty,
  extractFailureDetail,
  historySummary,
  observe,
  rerunFlips,
  shardAnnotations,
  shardSummary,
} from './lib/flake-report.mts'

const SPEC = 'tests/e2e/automation-interrupted-run.e2e.ts'
const OTHER = 'tests/e2e/acp-auth-error.e2e.ts'
const COMMIT = 'a'.repeat(40)

function row(
  spec: string,
  attempt: 1 | 2,
  outcome: SpecOutcome['outcome'],
  overrides: Partial<SpecOutcome> = {},
): SpecOutcome {
  return {
    version: 1,
    spec,
    attempt,
    outcome,
    exitCode: outcome === 'running' ? null : outcome === 'passed' ? 0 : 1,
    durationSeconds: outcome === 'running' ? null : 10,
    failureClass: outcome === 'failed' ? 'unclassified' : null,
    runId: '100',
    runAttempt: '1',
    shard: '9',
    commit: COMMIT,
    ...overrides,
  }
}

// Verbatim attempt-1 digest from schedule run 42454586003, shard 9 (job
// 128653551933), as the raw tee'd wdio log prints it before GitHub adds
// timestamps, plus an unrelated passing worker.
const LOG = `[chrome 152.0.7977.167 linux #0-5] » tests/e2e/acp-auth-error.e2e.ts
[chrome 152.0.7977.167 linux #0-5]    ✓ shows the auth error
[chrome 152.0.7977.167 linux #0-5] 1 passing (3.1s)
[chrome 152.0.7977.167 linux #0-6] Running: chrome (v152.0.7977.167) on linux
[chrome 152.0.7977.167 linux #0-6] Session ID: 94fd8be27da62d0a4919407dedf7a76c
[chrome 152.0.7977.167 linux #0-6]
[chrome 152.0.7977.167 linux #0-6] » tests/e2e/automation-interrupted-run.e2e.ts
[chrome 152.0.7977.167 linux #0-6] inactive automation after an interrupted app session
[chrome 152.0.7977.167 linux #0-6]    ✖ starts a fresh closed-project run and retains the interrupted checkpoint for explicit recovery
[chrome 152.0.7977.167 linux #0-6]
[chrome 152.0.7977.167 linux #0-6] 1 failing (7.6s)
[chrome 152.0.7977.167 linux #0-6]
[chrome 152.0.7977.167 linux #0-6] 1) inactive automation after an interrupted app session starts a fresh closed-project run and retains the interrupted checkpoint for explicit recovery
[chrome 152.0.7977.167 linux #0-6] WebDriverError: stale element reference: stale element not found in the current frame
[chrome 152.0.7977.167 linux #0-6] stale element reference: WebDriverError: stale element reference: stale element not found in the current frame
[chrome 152.0.7977.167 linux #0-6]     at async Context.<anonymous> (/home/runner/work/agent-pane/agent-pane/tests/e2e/automation-interrupted-run.e2e.ts:287:12)
`
const TITLE =
  'starts a fresh closed-project run and retains the interrupted checkpoint for explicit recovery'

describe('flake classification', () => {
  it('classifies each pair of shard attempts', () => {
    assert.equal(classifyAttempts([row(SPEC, 1, 'failed'), row(SPEC, 2, 'passed')]), 'retried-pass')
    assert.equal(
      classifyAttempts([row(SPEC, 1, 'running'), row(SPEC, 2, 'passed')]),
      'interrupted-then-passed',
    )
    assert.equal(
      classifyAttempts([row(SPEC, 1, 'passed'), row(SPEC, 2, 'failed')]),
      'passed-then-failed',
    )
    assert.equal(classifyAttempts([row(SPEC, 1, 'failed'), row(SPEC, 2, 'failed')]), 'failed')
    assert.equal(classifyAttempts([row(SPEC, 1, 'passed'), row(SPEC, 2, 'passed')]), 'passed')
    assert.equal(classifyAttempts([row(SPEC, 1, 'passed')]), 'passed')
    assert.equal(classifyAttempts([row(SPEC, 1, 'running')]), 'incomplete')
  })

  it('shares the retried-pass rule with the shadow gate', () => {
    assert.equal(passedOnRetry([row(SPEC, 1, 'failed'), row(SPEC, 2, 'passed')]), true)
    assert.equal(passedOnRetry([row(SPEC, 1, 'passed'), row(SPEC, 2, 'passed')]), false)
    assert.equal(passedOnRetry([row(SPEC, 1, 'running'), row(SPEC, 2, 'passed')]), false)
  })

  it('keeps workflow run attempts apart and counts same-commit re-run flips', () => {
    const rows = [
      // Run 100 attempt 1: failed both shard attempts.
      row(SPEC, 1, 'failed'),
      row(SPEC, 2, 'failed'),
      // "Re-run failed jobs": run 100 attempt 2 passes first time.
      row(SPEC, 1, 'passed', { runAttempt: '2' }),
      // A later run on another commit: absorbed by the shard retry.
      row(SPEC, 1, 'failed', { runId: '200', commit: 'b'.repeat(40) }),
      row(SPEC, 2, 'passed', { runId: '200', commit: 'b'.repeat(40) }),
      row(OTHER, 1, 'passed'),
      row(OTHER, 1, 'passed', { runId: '200', commit: 'b'.repeat(40) }),
    ]
    const observations = observe(rows)
    assert.equal(observations.length, 5)
    assert.deepEqual(rerunFlips(observations), [
      {
        spec: SPEC,
        commit: COMMIT,
        failed: { runId: '100', runAttempt: 1 },
        passed: { runId: '100', runAttempt: 2 },
      },
    ])
    const [first, second] = aggregate(observations)
    assert.deepEqual(first, {
      spec: SPEC,
      runsObserved: 3,
      attempt1Failures: 2,
      retriedPasses: 1,
      passedThenFailed: 0,
      rerunFlips: 1,
      finalFailures: 1,
      flakeRate: 2 / 3,
    })
    assert(second)
    assert.equal(second.spec, OTHER)
    assert.equal(second.flakeRate, 0)
  })

  it('does not call a pass that came before a failure a re-run flip', () => {
    const observations = observe([
      row(SPEC, 1, 'passed'),
      row(SPEC, 1, 'failed', { runAttempt: '2' }),
      row(SPEC, 2, 'failed', { runAttempt: '2' }),
    ])
    assert.deepEqual(rerunFlips(observations), [])
  })

  it('ignores incomplete observations when counting runs', () => {
    const stats = aggregate(observe([row(SPEC, 1, 'running')]))
    const [only] = stats
    assert(only)
    assert.equal(only.runsObserved, 0)
    assert.equal(only.flakeRate, 0)
  })
})

describe('attempt-1 failure detail', () => {
  it('reads titles and the error digest for the failing worker only', () => {
    assert.deepEqual(extractFailureDetail(LOG, SPEC), {
      titles: [TITLE],
      digest: [
        `1) inactive automation after an interrupted app session ${TITLE}`,
        'WebDriverError: stale element reference: stale element not found in the current frame',
        'stale element reference: WebDriverError: stale element reference: stale element not found in the current frame',
        'at async Context.<anonymous> (/home/runner/work/agent-pane/agent-pane/tests/e2e/automation-interrupted-run.e2e.ts:287:12)',
      ],
    })
    assert.deepEqual(extractFailureDetail(LOG, OTHER), { titles: [], digest: [] })
  })

  it('tolerates GitHub job-log timestamps and a leading slash in the spec header', () => {
    const stamped = LOG.split('\n')
      .map((line) => (line ? `2026-11-08T06:48:45.1087056Z ${line}` : line))
      .join('\n')
      .replace('» tests/e2e/automation', '» /tests/e2e/automation')
    assert.deepEqual(extractFailureDetail(stamped, SPEC).titles, [TITLE])
  })

  it('returns nothing when the session never started', () => {
    assert.deepEqual(extractFailureDetail('ERROR webdriver: session not created', SPEC), {
      titles: [],
      digest: [],
    })
  })
})

describe('rendering', () => {
  it('escapes workflow-command data and markdown cells', () => {
    assert.equal(escapeCommandData('50%\nnext'), '50%25%0Anext')
    assert.equal(escapeCommandProperty('a:b,c'), 'a%3Ab%2Cc')
    assert.equal(cell('a | <b>\n c'), 'a \\| &lt;b&gt; c')
  })

  it('emits one annotation and one summary row per flaky spec', () => {
    const [observation] = observe([row(SPEC, 1, 'failed'), row(SPEC, 2, 'passed')])
    assert(observation)
    const flakes = [{ observation, detail: extractFailureDetail(LOG, SPEC) }]
    const [annotation, ...rest] = shardAnnotations(flakes)
    assert.deepEqual(rest, [])
    assert.match(
      annotation ?? '',
      /^::warning file=tests\/e2e\/automation-interrupted-run\.e2e\.ts,title=Flaky e2e spec \(shard 9\)::/,
    )
    assert.match(annotation ?? '', /failed attempt 1, passed on the shard retry/)
    assert.match(annotation ?? '', /Attempt-1 error: 1\) inactive automation/)
    const summary = shardSummary('9', flakes)
    assert.match(summary, /### Flaky e2e specs in shard 9/)
    assert.match(summary, new RegExp(`\\| \`${SPEC.replaceAll('.', '\\.')}\` \\| retried-pass \\|`))
    assert.equal(shardSummary('9', []), '')
  })

  it('says so when nothing failed', () => {
    const observations = observe([row(OTHER, 1, 'passed')])
    const markdown = historySummary({ title: 'T', runs: 1 }, aggregate(observations), [])
    assert.match(markdown, /No spec failed on any attempt\./)
  })
})

describe('flake-report CLI', () => {
  const cli = resolve('scripts/flake-report.mts')

  it('annotates a shard whose spec failed attempt 1 and passed the retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flake-shard-'))
    try {
      const outcomes = join(dir, 'outcomes')
      mkdirSync(outcomes)
      const write = (name: string, value: SpecOutcome): void => {
        writeFileSync(join(outcomes, name), JSON.stringify(value) + '\n')
      }
      write('1-0-6-automation-interrupted-run.e2e.ts.json', row(SPEC, 1, 'failed'))
      write('2-0-6-automation-interrupted-run.e2e.ts.json', row(SPEC, 2, 'passed'))
      write('1-0-5-acp-auth-error.e2e.ts.json', row(OTHER, 1, 'passed'))
      write('2-0-5-acp-auth-error.e2e.ts.json', row(OTHER, 2, 'passed'))
      writeFileSync(join(outcomes, 'junk.json'), '{"not":"an outcome"}')
      symlinkSync('/etc/passwd', join(outcomes, 'link.json'))
      const log = join(dir, 'attempt-1.log')
      writeFileSync(log, LOG)
      const summary = join(dir, 'summary.md')
      const stdout = execFileSync(
        process.execPath,
        [cli, 'shard', outcomes, '--log', log, '--shard', '9'],
        { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
      )
      const warnings = stdout.split('\n').filter((line) => line.startsWith('::warning'))
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /automation-interrupted-run/)
      assert.match(
        stdout,
        /4 outcome record\(s\), 1 flaky spec\(s\), 2 unreadable file\(s\) skipped/,
      )
      const markdown = readFileSync(summary, 'utf8')
      assert.match(markdown, /Flaky e2e specs in shard 9/)
      assert.match(markdown, /stale element reference/)
      assert.doesNotMatch(markdown, /acp-auth-error/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes nothing to the summary for a clean shard and exits 0 without evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flake-clean-'))
    try {
      const summary = join(dir, 'summary.md')
      execFileSync(process.execPath, [cli, 'shard', join(dir, 'missing')], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      })
      assert.throws(() => readFileSync(summary, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aggregates every shard and run attempt under a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flake-aggregate-'))
    try {
      const put = (path: string, value: SpecOutcome): void => {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), JSON.stringify(value))
      }
      put('e2e-evidence-shard-9-1/1-a.json', row(SPEC, 1, 'failed'))
      put('e2e-evidence-shard-9-1/2-a.json', row(SPEC, 2, 'failed'))
      put('e2e-evidence-shard-9-2/1-a.json', row(SPEC, 1, 'passed', { runAttempt: '2' }))
      put('e2e-evidence-shard-3-1/1-b.json', row(OTHER, 1, 'failed', { shard: '3' }))
      put('e2e-evidence-shard-3-1/2-b.json', row(OTHER, 2, 'passed', { shard: '3' }))
      const summary = join(dir, 'summary.md')
      const stdout = execFileSync(
        process.execPath,
        [cli, 'aggregate', dir, '--title', 'Run flakes', '--annotate'],
        { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
      )
      const warnings = stdout.split('\n').filter((line) => line.startsWith('::warning'))
      assert.equal(warnings.length, 2)
      assert.match(
        warnings.join('\n'),
        /acp-auth-error.*failed attempt 1, passed on the shard retry/,
      )
      assert.match(
        warnings.join('\n'),
        /automation-interrupted-run.*failed in run 100 attempt 1 and passed in run 100 attempt 2/,
      )
      const markdown = readFileSync(summary, 'utf8')
      assert.match(markdown, /## Run flakes/)
      assert.match(markdown, /2 workflow run attempt\(s\), 2 spec\(s\) observed/)
      assert.match(markdown, /failed in run 100 attempt 1, passed in run 100 attempt 2/)
      assert.match(
        markdown,
        /\| `tests\/e2e\/acp-auth-error\.e2e\.ts` \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 100% \|/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
