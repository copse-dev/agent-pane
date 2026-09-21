import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

// Execute the actual gate script, not a second implementation of its policy.
const workflow = z
  .object({
    jobs: z.object({
      'ci-passed': z.object({
        steps: z.array(
          z.object({
            name: z.string(),
            if: z.string(),
            env: z.record(z.string(), z.string()).optional(),
            run: z.string(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8')))
const step = workflow.jobs['ci-passed'].steps.find((s) => s.name === 'Check upstream job results')
assert.ok(step)
const script = step.run
const bindings = step.env
assert.equal(step.if, '${{ !cancelled() }}')
const canceledStep = workflow.jobs['ci-passed'].steps[0]
assert.ok(canceledStep)
assert.equal(canceledStep.name, 'Reject canceled workflow')
assert.equal(canceledStep.if, '${{ cancelled() }}')
const cancellationScript = canceledStep.run

const successfulPr = {
  FORK_PR: 'false',
  MODE: 'full',
  ANY_FAILURE: 'false',
  ANY_CANCELLED: 'false',
  PRECHECK_RESULT: 'success',
  CHECK_RESULT: 'success',
  E2E_REQUIRED: 'true',
  E2E_SHARD_TOTAL: '8',
  E2E_RESULT: 'success',
  NEEDS_JSON: '{}',
}

function gate(overrides: Record<string, string> = {}): number | null {
  // The child environment is exactly the Actions bindings: no PATH, no
  // inherited variables. The script therefore only works while it uses shell
  // built-ins (echo, printf, [, case, exit), which is also what keeps the
  // hosted gate free of checkout, install and network dependencies.
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { ...successfulPr, ...overrides },
    timeout: 5_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, result.stderr)
  return result.status
}

describe('required CI gate bindings', () => {
  it('receives cancellation and dependency results directly from Actions, without shell interpolation', () => {
    assert.deepEqual(bindings, {
      FORK_PR:
        "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
      MODE: '${{ needs.precheck.outputs.mode }}',
      ANY_FAILURE: "${{ contains(needs.*.result, 'failure') }}",
      ANY_CANCELLED: "${{ contains(needs.*.result, 'cancelled') }}",
      PRECHECK_RESULT: '${{ needs.precheck.result }}',
      CHECK_RESULT: '${{ needs.check.result }}',
      E2E_REQUIRED:
        "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && (github.event.pull_request.draft == false || contains(github.event.pull_request.labels.*.name, 'ci-full')) }}",
      E2E_SHARD_TOTAL: '${{ needs.precheck.outputs.e2e_shard_total }}',
      E2E_RESULT: '${{ needs.e2e.result }}',
      NEEDS_JSON: '${{ toJSON(needs) }}',
    })
    assert.doesNotMatch(script, /\$\{\{/)
  })
})

describe('required CI gate decisions', { skip: process.platform === 'win32' }, () => {
  it('fails the whole-run cancellation step before dependency acceptance can run', () => {
    const result = spawnSync('bash', ['-e', '-c', cancellationScript], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 1)
  })
  for (const mode of ['full', 'subset', 'skip']) {
    for (const fork of ['true', 'false']) {
      it(`rejects a canceled dependency in ${mode} / fork=${fork}, even with a newer tip or run`, () => {
        assert.equal(
          gate({
            MODE: mode,
            FORK_PR: fork,
            ANY_CANCELLED: 'true',
            TIP_SHA: 'new-tip',
            NEWER_RUN_ID: '999999',
          }),
          1,
        )
      })
    }
  }

  it('rejects real failures even in screenshot-only skip mode', () => {
    assert.equal(gate({ MODE: 'skip', ANY_FAILURE: 'true' }), 1)
  })

  it('requires successful precheck for same-repository and fork runs', () => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      for (const fork of ['false', 'true']) {
        assert.equal(gate({ PRECHECK_RESULT: result, FORK_PR: fork }), 1)
      }
    }
  })

  it('requires the same-repository unit job even when heavy jobs are intentionally skipped', () => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(gate({ MODE: 'skip', CHECK_RESULT: result }), 1)
    }
  })

  it('accepts a successful fork safe tier without claiming the same-repository context', () => {
    assert.equal(gate({ FORK_PR: 'true', CHECK_RESULT: 'skipped', E2E_RESULT: 'skipped' }), 0)
  })

  it('accepts successful full and subset runs, but rejects missing or invalid plans', () => {
    assert.equal(gate(), 0)
    assert.equal(gate({ MODE: 'subset' }), 0)
    assert.equal(gate({ MODE: '' }), 1)
    assert.equal(gate({ MODE: 'unknown' }), 1)
  })

  it('accepts intentional screenshot-only, zero-shard, draft, and trunk-push e2e skips', () => {
    assert.equal(gate({ MODE: 'skip', E2E_SHARD_TOTAL: '0', E2E_RESULT: 'skipped' }), 0)
    assert.equal(gate({ E2E_SHARD_TOTAL: '0', E2E_RESULT: 'skipped' }), 0)
    assert.equal(gate({ E2E_REQUIRED: 'false', E2E_RESULT: 'skipped' }), 0)
  })

  it('requires successful e2e when the PR dispatch contract demands it', () => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(gate({ E2E_RESULT: result }), 1)
    }
  })
})
