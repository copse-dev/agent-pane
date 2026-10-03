import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

const jobSchema = z.object({
  if: z.string().optional(),
  name: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z
    .array(
      z.object({ env: z.record(z.string(), z.string()).optional(), run: z.string().optional() }),
    )
    .optional(),
})
const workflow = z
  .object({
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.string() }),
    jobs: z.record(z.string(), jobSchema),
  })
  .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8')))
const meaningfulLabels = [
  'ci-full',
  'update-screenshots',
  'bench-agent',
  'bench-doctrine',
  'eval-tool-preference',
  'bench-agent-eval',
]

type EventContext = {
  event_name: string
  run_id: number
  ref: string
  repository: string
  base_ref: string
  event: {
    action: string
    changes: Record<string, unknown>
    label: { name: string }
    pull_request: { number: number; head: { repo: { full_name: string } } }
  }
}

function context(action: string, changes: Record<string, unknown> = {}, label = ''): EventContext {
  return {
    event_name: 'pull_request',
    run_id: 123,
    ref: 'refs/pull/42/merge',
    repository: 'copse-dev/agent-pane',
    base_ref: 'main',
    event: {
      action,
      changes: { title: null, body: null, base: null, ...changes },
      label: { name: label },
      pull_request: { number: 42, head: { repo: { full_name: 'copse-dev/agent-pane' } } },
    },
  }
}

// These routing expressions use only GitHub equality, short-circuit boolean
// operators, null comparisons, and format with scalar arguments. Fixtures fill
// missing fields with null, matching Actions' missing-property semantics.
function evaluate(expression: string, github: EventContext): unknown {
  const source = expression.trim().startsWith('${{') ? expression.trim().slice(3, -2) : expression
  const result: unknown = runInNewContext(source, {
    github,
    always: () => true,
    success: () => true,
    format: (pattern: string, value: string | number) => pattern.replace('{0}', String(value)),
  })
  return result
}

function binding(name: string): z.infer<typeof jobSchema> {
  const job = workflow.jobs[name]
  assert.ok(job, name)
  assert.ok(job.if, `${name} must have an admission condition`)
  return job
}
function admitted(github: EventContext): {
  precheck: unknown
  autoformat: unknown
  aggregate: unknown
  name: unknown
  group: unknown
  cancels: unknown
  metadataOnly: unknown
} {
  return {
    precheck: evaluate(binding('precheck').if ?? '', github),
    autoformat: evaluate(binding('autoformat').if ?? '', github),
    aggregate: evaluate(binding('ci-passed').if ?? '', github),
    name: evaluate(binding('ci-passed').name ?? '', github),
    group: evaluate(workflow.concurrency.group, github),
    cancels: evaluate(workflow.concurrency['cancel-in-progress'], github),
    metadataOnly: evaluate(
      workflow.jobs['ci-passed']?.steps?.find((step) => step.env?.['METADATA_ONLY'])?.env?.[
        'METADATA_ONLY'
      ] ?? '',
      github,
    ),
  }
}

const cosmetics = [context('labeled', {}, 'review-has-feedback')]

describe('cosmetic CI event routing', () => {
  it('never publishes the required aggregate or executes either independent root for metadata', () => {
    for (const github of cosmetics) {
      const route = admitted(github)
      assert.equal(route.precheck, false)
      assert.equal(route.autoformat, false)
      assert.equal(route.aggregate, true)
      assert.equal(route.metadataOnly, true)
      assert.equal(route.name, 'CI metadata ignored')
      assert.equal(route.cancels, false)
    }
    // All other candidate jobs have a dependency path to precheck. Their
    // default success() guard stops them when it skips; screenshot-artifacts
    // explicitly requires successful build and e2e results despite !cancelled().
    const rooted = (name: string): boolean => {
      if (name === 'precheck') return true
      const dependencies = workflow.jobs[name]?.needs
      return (typeof dependencies === 'string' ? [dependencies] : (dependencies ?? [])).some(rooted)
    }
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === 'precheck' || name === 'autoformat' || name === 'ci-passed') continue
      assert.ok(rooted(name), `${name} must inherit the precheck admission boundary`)
      if (/always\(|cancelled\(/.test(job.if ?? '')) {
        assert.equal(
          name,
          'screenshot-artifacts',
          'new status-function jobs need explicit admission',
        )
        assert.ok(job.if?.includes("needs.build.result == 'success'"))
        assert.ok(job.if?.includes("needs.e2e.result == 'success'"))
      }
    }
  })

  it('cannot turn a red or absent required check green through a successful metadata no-op', () => {
    for (const original of ['failure', undefined]) {
      for (const github of cosmetics) {
        const checks = new Map<string, string>()
        if (original) checks.set('CI Passed', original)
        const route = admitted(github)
        assert.equal(typeof route.name, 'string')
        if (typeof route.name !== 'string') throw new Error('Missing aggregate name')
        checks.set(route.name, 'success')
        assert.equal(checks.get('CI Passed'), original)
      }
    }
  })

  it('cannot replace a pending real run through shared workflow concurrency', () => {
    const real = admitted(context('synchronize'))
    assert.equal(real.group, 'ci-42')
    for (const github of cosmetics) {
      assert.equal(admitted(github).group, 'ci-metadata-123')
      assert.notEqual(admitted(github).group, real.group)
      assert.notEqual(admitted({ ...github, run_id: 124 }).group, admitted(github).group)
    }
  })

  it('runs normal CI for retargets, meaningful labels, unknown edits and ordinary events', () => {
    const real = [
      context('edited', { title: { from: 'Previous title' } }),
      context('edited', { body: { from: '' } }),
      context('edited', { title: { from: '' }, body: { from: 'Previous body' } }),
      context('edited', { base: { ref: { from: 'release' } } }),
      context('edited', { base: { ref: { from: 'release' } }, body: { from: '' } }),
      context('edited'),
      context('edited', { unknown: { from: '' } }),
      context('edited', { title: { from: '' }, reviewer: { from: '' } }),
      context('edited', { body: { from: '' }, unknown: { from: '' } }),
      context('labeled', {}, 'future-ci-label'),
      context('future-action'),
      ...meaningfulLabels.map((name) => context('labeled', {}, name)),
      ...['opened', 'synchronize', 'reopened', 'ready_for_review'].map((action) => context(action)),
      ...['push', 'schedule', 'merge_group'].map((event_name) => ({
        ...context('edited'),
        event_name,
      })),
    ]
    for (const github of real) {
      const route = admitted(github)
      assert.equal(route.precheck, true, JSON.stringify(github))
      assert.equal(route.aggregate, true)
      assert.equal(route.metadataOnly, false)
      assert.equal(route.name, 'CI Passed')
      assert.equal(route.group, 'ci-42')
      assert.equal(route.cancels, github.event_name !== 'schedule')
    }
  })

  it('preserves the distinct fork and trunk contexts on real runs', () => {
    const fork = context('synchronize')
    fork.event.pull_request.head.repo.full_name = 'external/agent-pane'
    assert.equal(admitted(fork).name, 'Fork CI Passed')
    const trunk = { ...context(''), event_name: 'push', ref: 'refs/heads/main' }
    assert.equal(admitted(trunk).name, 'Develop CI Passed')
  })

  it('keeps every label consumed by CI outside the cosmetic label', () => {
    const source = readFileSync('.github/workflows/ci.yml', 'utf8')
    const consumed = [
      ...source.matchAll(/contains\(github\.event\.pull_request\.labels\.\*\.name, '([^']+)'\)/g),
    ].map((match) => match[1])
    assert.deepEqual([...new Set(consumed)].sort(), [...meaningfulLabels].sort())
    assert.ok(!meaningfulLabels.includes('review-has-feedback'))
  })
})
