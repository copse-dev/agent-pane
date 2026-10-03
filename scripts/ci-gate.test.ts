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
  MERGE_GROUP: 'false',
  BUILD_RESULT: 'success',
  REVIEW_CELL_REQUIRED: 'false',
  REVIEW_CELL_RESULT: 'skipped',
  QUEUE_BASE_REF: 'refs/heads/main',
  BENCH_RESULT: 'skipped',
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
      MERGE_GROUP: "${{ github.event_name == 'merge_group' }}",
      BUILD_RESULT: '${{ needs.build.result }}',
      REVIEW_CELL_REQUIRED: '${{ needs.precheck.outputs.review_cell_required }}',
      REVIEW_CELL_RESULT: '${{ needs.review-cell.result }}',
      QUEUE_BASE_REF: '${{ github.event.merge_group.base_ref }}',
      BENCH_RESULT: '${{ needs.bench.result }}',
      E2E_REQUIRED:
        "${{ github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && (github.event.pull_request.draft == false || contains(github.event.pull_request.labels.*.name, 'ci-full'))) }}",
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

  it('requires the queue build even when the oracle skips e2e', () => {
    for (const mode of ['full', 'subset', 'skip']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        assert.equal(gate({ MERGE_GROUP: 'true', MODE: mode, BUILD_RESULT: result }), 1)
      }
    }
    assert.equal(
      gate({ MERGE_GROUP: 'true', MODE: 'skip', E2E_SHARD_TOTAL: '0', E2E_RESULT: 'skipped' }),
      0,
    )
  })

  it('requires a positive shard count for every queue plan that requests e2e', () => {
    for (const mode of ['full', 'subset']) {
      assert.equal(gate({ MERGE_GROUP: 'true', MODE: mode }), 0)
      for (const total of ['0', '00', '', '-1', 'invalid']) {
        assert.equal(gate({ MERGE_GROUP: 'true', MODE: mode, E2E_SHARD_TOTAL: total }), 1)
      }
    }
  })

  it('rejects queue e2e that did not successfully execute', () => {
    for (const mode of ['full', 'subset']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        assert.equal(gate({ MERGE_GROUP: 'true', MODE: mode, E2E_RESULT: result }), 1)
      }
    }
  })

  it('rejects missing queue base or reviewer-cell metadata', () => {
    for (const required of ['', 'invalid']) {
      assert.equal(gate({ MERGE_GROUP: 'true', REVIEW_CELL_REQUIRED: required }), 1)
    }
    for (const base of ['', 'main', 'refs/heads/unknown']) {
      assert.equal(gate({ MERGE_GROUP: 'true', QUEUE_BASE_REF: base }), 1)
    }
  })

  it('requires queue reviewer-cell conformance when the plan demands it', () => {
    for (const mode of ['full', 'subset', 'skip']) {
      assert.equal(
        gate({
          MERGE_GROUP: 'true',
          MODE: mode,
          REVIEW_CELL_REQUIRED: 'true',
          REVIEW_CELL_RESULT: 'success',
        }),
        0,
      )
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        assert.equal(
          gate({
            MERGE_GROUP: 'true',
            MODE: mode,
            REVIEW_CELL_REQUIRED: 'true',
            REVIEW_CELL_RESULT: result,
          }),
          1,
        )
      }
    }
  })

  it('requires benchmarks on release queue groups but permits intentional main skips', () => {
    assert.equal(gate({ MERGE_GROUP: 'true', BENCH_RESULT: 'skipped' }), 0)
    assert.equal(
      gate({ MERGE_GROUP: 'true', QUEUE_BASE_REF: 'refs/heads/release', BENCH_RESULT: 'success' }),
      0,
    )
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(
        gate({ MERGE_GROUP: 'true', QUEUE_BASE_REF: 'refs/heads/release', BENCH_RESULT: result }),
        1,
      )
    }
  })

  it('rejects canceled queue dependencies even when e2e was intentionally skipped', () => {
    for (const mode of ['full', 'subset', 'skip']) {
      assert.equal(gate({ MERGE_GROUP: 'true', MODE: mode, ANY_CANCELLED: 'true' }), 1)
    }
  })

  it('requires successful e2e when the PR dispatch contract demands it', () => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(gate({ E2E_RESULT: result }), 1)
    }
  })
})
