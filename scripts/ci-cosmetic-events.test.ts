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
    changes?: Record<string, unknown>
    label: { name: string }
    pull_request: { number: number; head: { repo: { full_name: string } } }
  }
}

// `changes` is passed through as GitHub sends it: absent keys stay absent,
// because the edit predicate compares the serialised object, key for key.
function context(action: string, changes?: Record<string, unknown>, label = ''): EventContext {
  return {
    event_name: 'pull_request',
    run_id: 123,
    ref: 'refs/pull/42/merge',
    repository: 'copse-dev/agent-pane',
    base_ref: 'main',
    event: {
      action,
      ...(changes ? { changes } : {}),
      label: { name: label },
      pull_request: { number: 42, head: { repo: { full_name: 'copse-dev/agent-pane' } } },
    },
  }
}

// These routing expressions use only GitHub equality, short-circuit boolean
// operators, null comparisons, format, toJSON and fromJSON. Actions reads a
// property of a missing object as null; optional chaining reads it as
// undefined, which `==`/`!=` treat alike and toJSON maps to `null`.
function evaluate(expression: string, github: EventContext): unknown {
  const source = (
    expression.trim().startsWith('${{') ? expression.trim().slice(3, -2) : expression
  ).replace(/\bgithub(?:\.[\w-]+)+/g, (path) => path.replaceAll('.', '?.'))
  const result: unknown = runInNewContext(source, {
    github,
    always: () => true,
    success: () => true,
    format: (pattern: string, ...values: unknown[]) =>
      pattern.replace(/\{\{|\}\}|\{(\d+)\}/g, (token: string, index?: string) =>
        index === undefined ? token.charAt(0) : String(values[Number(index)]),
      ),
    toJSON: (value: unknown) => JSON.stringify(value ?? null, null, 2),
    fromJSON: (text: string): unknown => JSON.parse(text),
  })
  return result
}

function binding(name: string): z.infer<typeof jobSchema> {
  const job = workflow.jobs[name]
  assert.ok(job, name)
  return job
}
function admitted(github: EventContext): {
  precheck: unknown
  autoformat: unknown
  aggregate: unknown
  name: unknown
  group: unknown
  cancels: unknown
} {
  return {
    precheck: evaluate(binding('precheck').if ?? 'true', github),
    autoformat: evaluate(binding('autoformat').if ?? '', github),
    aggregate: evaluate(binding('ci-passed').if ?? '', github),
    name: evaluate(binding('ci-passed').name ?? '', github),
    group: evaluate(workflow.concurrency.group, github),
    cancels: evaluate(workflow.concurrency['cancel-in-progress'], github),
  }
}

const cosmetics = [
  context('labeled', {}, 'review-has-feedback'),
  context('edited', { title: { from: 'Previous title' } }),
  context('edited', { body: { from: '' } }),
  context('edited', { body: { from: null } }),
  context('edited', { title: { from: '' }, body: { from: 'Previous body' } }),
  context('edited', { body: { from: 'Previous body' }, title: { from: '' } }),
  // Text that looks like the reconstruction's own syntax round-trips intact.
  context('edited', { body: { from: '{0}"title":{1}}}\n\'quoted\' ${{ x }}' } }),
]

describe('cosmetic CI event routing', () => {
  it('tests metadata candidates without starting the autoformatter or cancelling source CI', () => {
    for (const github of cosmetics) {
      const route = admitted(github)
      assert.equal(route.precheck, true)
      assert.equal(route.autoformat, false)
      assert.equal(route.aggregate, true)
      assert.equal(route.name, 'CI Passed')
      assert.equal(route.cancels, false)
    }
    // All candidate jobs retain their dependency path to precheck; screenshot-artifacts
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

  it('has no metadata shortcut in the required aggregate or precheck', () => {
    const aggregate = binding('ci-passed')
    assert.equal(binding('precheck').if, undefined)
    assert.ok(aggregate.steps?.some((step) => step.env?.['PRECHECK_RESULT']))
    assert.ok(aggregate.steps?.every((step) => !Object.hasOwn(step.env ?? {}, 'METADATA_ONLY')))
    assert.ok(aggregate.steps?.every((step) => !step.run?.includes('Metadata event ignored')))
    assert.ok(!aggregate.name?.includes('CI metadata ignored'))
  })

  it('binds one identical metadata predicate for concurrency and autoformat', () => {
    const group = workflow.concurrency.group.trim()
    const predicate = /^\$\{\{ \((.+)\) && format\('ci-metadata-/s.exec(group)?.[1]
    assert.ok(predicate, 'concurrency must isolate the exact metadata predicate')
    assert.ok(predicate.includes("github.event.action == 'edited'"))
    assert.doesNotMatch(predicate, /\}\}/)
    for (const [site, text] of [
      ['concurrency.cancel-in-progress', workflow.concurrency['cancel-in-progress']],
      ['autoformat.if', binding('autoformat').if],
    ] as const) {
      assert.ok(text?.includes(`(${predicate})`), `${site} must use the shared metadata predicate`)
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
      context('edited', { base: { ref: { from: 'release' } } }),
      context('edited', { title: { from: '' }, base: { ref: { from: 'release' } } }),
      context('edited', { title: { from: '' }, body: { from: '' }, base: { ref: { from: 'a' } } }),
      context('edited', {}),
      context('edited', { base: { ref: { from: 'release' } }, body: { from: '' } }),
      context('edited'),
      context('edited', { unknown: { from: '' } }),
      context('edited', { title: { from: '' }, reviewer: { from: '' } }),
      context('edited', { body: { from: '' }, unknown: { from: '' } }),
      context('edited', { title: { from: '' }, body: { from: '' }, unknown: { from: '' } }),
      context('edited', { unknown: { from: '' }, title: { from: '' } }),
      context('labeled', { title: { from: '' } }, 'ci-full'),
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
      assert.equal(route.name, 'CI Passed')
      assert.equal(route.group, 'ci-42')
      assert.equal(route.cancels, github.event_name !== 'schedule')
    }
  })

  it('preserves the distinct fork and trunk contexts, including metadata', () => {
    for (const github of cosmetics) {
      github.event.pull_request.head.repo.full_name = 'external/agent-pane'
      assert.equal(admitted(github).name, 'Fork CI Passed')
      github.event.pull_request.head.repo.full_name = 'copse-dev/agent-pane'
    }
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
