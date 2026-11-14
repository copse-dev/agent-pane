import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

const readOnly = z.object({ contents: z.literal('read') }).strict()
const workflow = z
  .object({
    on: z.object({ workflow_dispatch: z.null() }).loose(),
    permissions: readOnly,
    jobs: z.object({
      'docker-path': z.object({ if: z.string() }),
      'composer-canonical-pair': z.object({
        if: z.string(),
        'runs-on': z.literal('ubuntu-24.04'),
        'timeout-minutes': z.literal(35),
        permissions: readOnly,
        env: z.record(z.string(), z.string()),
        steps: z.array(
          z.object({
            name: z.string().optional(),
            uses: z.string().optional(),
            run: z.string().optional(),
            if: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync(resolve('.github/workflows/thread-container.yml'), 'utf8')))

const branch = 'codex/composer-canonical-diagnostic-20261114'
function context(
  event: string,
  head = '',
  ref = 'refs/heads/main',
  sameRepo = true,
  attempt = '1',
): { github: Record<string, unknown> } {
  return {
    github: {
      event_name: event,
      repository: 'copse-dev/agent-pane',
      head_ref: head,
      ref,
      run_attempt: attempt,
      event: {
        pull_request: {
          head: { repo: { full_name: sameRepo ? 'copse-dev/agent-pane' : 'fork/agent-pane' } },
        },
      },
    },
  }
}

function admitted(
  job: 'docker-path' | 'composer-canonical-pair',
  value: ReturnType<typeof context>,
): boolean {
  const expression = workflow.jobs[job].if
  assert.match(expression, /^[\w\s.'"/=&|!()-]+$/)
  const result: unknown = runInNewContext(expression, value, { timeout: 500 })
  assert.equal(typeof result, 'boolean')
  return result === true
}

describe('bounded composer diagnostic admission', () => {
  it('runs only the pair on its first explicit dispatch, never the Docker suite', () => {
    const event = context('workflow_dispatch', '', `refs/heads/${branch}`)
    assert.equal(admitted('composer-canonical-pair', event), true)
    assert.equal(admitted('docker-path', event), false)
    assert.equal(
      admitted(
        'composer-canonical-pair',
        context('workflow_dispatch', '', `refs/heads/${branch}`, true, '2'),
      ),
      false,
    )
  })

  it('does not turn a diagnostic PR or a fork PR into a native run', () => {
    for (const sameRepo of [true, false]) {
      const event = context('pull_request', branch, 'refs/pull/123/merge', sameRepo)
      assert.equal(admitted('composer-canonical-pair', event), false)
      assert.equal(admitted('docker-path', event), false)
    }
    assert.equal(
      admitted('docker-path', context('pull_request', 'normal', 'refs/pull/124/merge', false)),
      false,
    )
  })

  it('preserves ordinary same-repository, nightly and main-dispatch Docker coverage', () => {
    for (const event of [
      context('pull_request', 'normal'),
      context('schedule'),
      context('workflow_dispatch'),
    ]) {
      assert.equal(admitted('docker-path', event), true)
      assert.equal(admitted('composer-canonical-pair', event), false)
    }
  })

  it('uses normal setup, read-only checkout, bounded retention and always-run evidence', () => {
    const steps = workflow.jobs['composer-canonical-pair'].steps
    assert.equal(steps.filter((step) => step.uses === './.github/actions/setup').length, 1)
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7.0.1')
    assert.ok(checkout?.with)
    assert.equal(checkout.with['persist-credentials'], false)
    const artifact = steps.find((step) => step.uses === 'actions/upload-artifact@v7')
    assert.ok(artifact?.with)
    assert.equal(artifact.if, 'always()')
    assert.equal(artifact.with['retention-days'], 5)
    assert.equal(artifact.with['if-no-files-found'], 'error')
    assert.equal(steps.filter((step) => step.run?.includes('run.py" run')).length, 1)
    assert.doesNotMatch(
      readFileSync(resolve('.github/workflows/thread-container.yml'), 'utf8'),
      /secrets\./,
    )
  })

  it('binds runner context only in the two execution steps, where GitHub permits it', () => {
    // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
    const job = workflow.jobs['composer-canonical-pair']
    for (const value of Object.values(job.env)) assert.doesNotMatch(value, /\$\{\{[^}]*\brunner\./)
    const execution = job.steps.filter((step) => step.run?.includes('run.py'))
    assert.equal(execution.length, 2)
    for (const step of execution)
      assert.equal(step.env?.['DIAGNOSTIC_RUNNER_ENVIRONMENT'], '${{ runner.environment }}')
  })
})
