import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

const workflowSchema = z.object({
  jobs: z.object({
    e2e: z.object({
      strategy: z.object({ 'fail-fast': z.string() }),
    }),
  }),
})
const workflow = workflowSchema.parse(
  load(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')),
)
const expression = workflow.jobs.e2e.strategy['fail-fast'].trim()

function failFast(event: string, fleet: string, labels: string[] = []): boolean {
  assert.ok(expression.startsWith('${{') && expression.endsWith('}}'))
  const source = expression
    .slice(3, -2)
    .trim()
    .replaceAll('github.event.pull_request.labels.*.name', 'labels')
  assert.match(source, /^[a-zA-Z0-9_.'", ()&|=!\s-]+$/)
  // Evaluate the actual boolean routing expression. GitHub compares strings
  // without case sensitivity; all other contexts are unused by this policy.
  const result: unknown = runInNewContext(
    source,
    {
      github: { event_name: event.toLowerCase() },
      vars: { SELF_HOSTED_E2E: fleet.toLowerCase() },
      labels,
      contains: (values: string[], expected: string): boolean =>
        values.some((value) => value.toLowerCase() === expected.toLowerCase()),
    },
    { timeout: 100 },
  )
  assert.ok(typeof result === 'boolean')
  return result
}

describe('independent hosted PR validation shards', () => {
  it('retains sibling results when a hosted PR worker fails', () => {
    for (const fleet of ['', 'ubuntu-latest', 'copse-e2e-typo', 'copse-e2e ']) {
      assert.equal(failFast('pull_request', fleet), false, fleet || 'default hosted runner')
    }
  })

  it('preserves fail-fast for explicitly selected self-hosted PR workers', () => {
    assert.equal(failFast('pull_request', 'copse-e2e'), true)
    assert.equal(failFast('pull_request', 'COPSE-E2E'), true)
  })

  it('retains the explicit full-run exception for either runner', () => {
    for (const fleet of ['', 'copse-e2e']) {
      assert.equal(failFast('pull_request', fleet, ['ci-full']), false)
      assert.equal(failFast('pull_request', fleet, ['CI-FULL']), false)
    }
  })

  it('preserves non-PR cancellation policy without expanding scheduled work', () => {
    for (const event of ['push', 'schedule', 'merge_group', 'workflow_dispatch']) {
      for (const fleet of ['', 'copse-e2e']) assert.equal(failFast(event, fleet), true)
    }
  })
})
