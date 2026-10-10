import { Script } from 'node:vm'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'
import {
  attestScreenshotStack,
  parseScreenshotStack,
  reconcileScreenshotStack,
  STACK_COVERAGE,
  STACK_DECISION,
  verifyScreenshotStack,
  type StackGitHub,
} from './screenshot-stack.mts'

const LOWER = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const TEXT = `<!-- copse-screenshot-stack: #1@${LOWER} tip=#2 -->`
const input = { owner: 'copse-dev', repo: 'agent-pane', number: 1 }
const tipInput = { ...input, number: 2 }
const declaration = parseScreenshotStack(TEXT)
assert.ok(declaration)
const DIGEST = declaration.digest

function pull(number: number, sha: string, body = TEXT): Record<string, unknown> {
  return {
    number,
    body,
    state: 'open',
    draft: false,
    head: { sha, repo: { full_name: 'copse-dev/agent-pane' } },
  }
}
function status(
  context: string,
  id: number,
  description = 'Declined by @reviewer; no candidate committed',
  state = 'success',
  author = 41898282,
): { context: string; id: number; description: string; state: string; creator: { id: number } } {
  return { context, id, description, state, creator: { id: author } }
}
interface Fixture {
  github: StackGitHub
  pulls: Map<number, Record<string, unknown>>
  statuses: Map<string, unknown[]>
  writes: Parameters<StackGitHub['rest']['repos']['createCommitStatus']>[0][]
  diverge(): void
  duringCompare(callback: () => void): void
}
function fixture(): Fixture {
  const pulls = new Map<number, Record<string, unknown>>([
    [1, pull(1, LOWER)],
    [2, pull(2, TIP)],
  ])
  const statuses = new Map<string, unknown[]>([
    [LOWER, []],
    [
      TIP,
      [
        status('Screenshot review', 1),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
        status(STACK_DECISION, 3, `Stack decision ${DIGEST}`),
      ],
    ],
  ])
  const writes: Parameters<StackGitHub['rest']['repos']['createCommitStatus']>[0][] = []
  let ancestry = true
  let onCompare: (() => void) | undefined
  const github: StackGitHub = {
    rest: {
      pulls: { get: async ({ pull_number }) => ({ data: pulls.get(pull_number) }) },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          onCompare?.()
          return {
            data: {
              status: ancestry ? 'ahead' : 'diverged',
              merge_base_commit: { sha: basehead.split('...')[0] },
            },
          }
        },
        listCommitStatusesForRef: async ({ ref }) => ({ data: statuses.get(ref) ?? [] }),
        createCommitStatus: async (write) => {
          writes.push(write)
        },
      },
    },
  }
  return {
    github,
    pulls,
    statuses,
    writes,
    diverge: (): void => {
      ancestry = false
    },
    duringCompare: (callback: () => void): void => {
      onCompare = callback
    },
  }
}

describe('screenshot stack declarations', () => {
  it('keeps ordinary PRs outside the opt-in and parses pinned stacks', () => {
    assert.equal(parseScreenshotStack(null), null)
    assert.equal(parseScreenshotStack('ordinary PR'), null)
    assert.equal(declaration.tip, 2)
    assert.deepEqual(declaration.members, [{ number: 1, sha: LOWER }])
    assert.equal(parseScreenshotStack(`prose\n${TEXT}\nmore prose`)?.digest, DIGEST)
  })
  it('rejects malformed, duplicate, unpinned, oversized, and ambiguous declarations', () => {
    for (const text of [
      `${TEXT}\n${TEXT}`,
      `${TEXT}\n<!-- copse-screenshot-stack: malformed`,
      '<!-- copse-screenshot-stack: tip=#2 -->',
      '<!-- copse-screenshot-stack: #1@abc tip=#2 -->',
      `<!-- copse-screenshot-stack: #1@${LOWER} #1@${LOWER} tip=#2 -->`,
      `<!-- copse-screenshot-stack: #2@${LOWER} tip=#2 -->`,
      `<!-- copse-screenshot-stack: #9007199254740992@${LOWER} tip=#2 -->`,
      `<!-- copse-screenshot-stack: ${Array.from({ length: 20 }, (_, n) => `#${String(n + 1)}@${LOWER}`).join(' ')} tip=#21 -->`,
    ])
      assert.throws(() => parseScreenshotStack(text), Error, text)
  })
})

describe('combined stack review gates', () => {
  it('defers lower review only to an approved tip with declaration-bound coverage', async () => {
    const f = fixture()
    const stack = await verifyScreenshotStack(f.github, input)
    assert.equal(stack?.lower, true)
    assert.equal(stack.approved, true)
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.at(-1)?.state, 'success')
    assert.match(f.writes.at(-1)?.description ?? '', /Stack deferred to approved tip #2/)
    await reconcileScreenshotStack(f.github, tipInput)
    assert.equal(f.writes.length, 1, 'tip retains its normal visual review decision')
  })
  it('does not treat missing, stale, pending, revoked, or untrusted evidence as approval', async () => {
    for (const statuses of [
      [status('Screenshot review', 1)],
      [
        status('Screenshot review', 1, 'No changed reference screenshots'),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
      ],
      [status('Screenshot review', 1), status(STACK_COVERAGE, 2, 'Stack coverage stale')],
      [
        status('Screenshot review', 1, '', 'pending'),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
      ],
      [
        status('Screenshot review', 1),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
        status('Screenshot review', 3, '', 'error'),
      ],
      [
        status('Screenshot review', 1, '', 'success', 123),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
      ],
      [
        status('Screenshot review', 1),
        status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`, 'success', 123),
      ],
    ]) {
      const f = fixture()
      f.statuses.set(TIP, [...statuses, status(STACK_DECISION, 10, `Stack decision ${DIGEST}`)])
      assert.equal((await verifyScreenshotStack(f.github, input))?.approved, false)
      await reconcileScreenshotStack(f.github, input)
      assert.equal(f.writes.at(-1)?.state, 'pending')
    }
  })
  it('rejects changed lower heads, mismatched declarations, closed/draft tips and forks', async () => {
    for (const mutate of [
      (f: Fixture): Map<number, Record<string, unknown>> => f.pulls.set(1, pull(1, BASE)),
      (f: Fixture): Map<number, Record<string, unknown>> => f.pulls.set(2, pull(2, TIP, '')),
      (f: Fixture): Map<number, Record<string, unknown>> =>
        f.pulls.set(2, { ...pull(2, TIP), state: 'closed', merged: true }),
      (f: Fixture): Map<number, Record<string, unknown>> =>
        f.pulls.set(2, { ...pull(2, TIP), draft: true }),
      (f: Fixture): Map<number, Record<string, unknown>> =>
        f.pulls.set(1, {
          ...pull(1, LOWER),
          head: { sha: LOWER, repo: { full_name: 'fork/agent-pane' } },
        }),
      (f: Fixture): Map<number, Record<string, unknown>> =>
        f.pulls.set(1, { ...pull(1, LOWER), state: 'closed', merged: false }),
    ]) {
      const f = fixture()
      mutate(f)
      await assert.rejects(verifyScreenshotStack(f.github, input))
    }
  })
  it('allows already merged lower PRs while the frozen tip still contains them', async () => {
    const f = fixture()
    f.pulls.set(1, { ...pull(1, LOWER), state: 'closed', merged: true })
    assert.equal((await verifyScreenshotStack(f.github, tipInput))?.approved, true)
  })
  it('rejects unrelated history and racing pushes', async () => {
    const diverged = fixture()
    diverged.diverge()
    await assert.rejects(verifyScreenshotStack(diverged.github, input), /ancestor chain/)
    const raced = fixture()
    raced.duringCompare(() => raced.pulls.set(1, pull(1, BASE)))
    await assert.rejects(verifyScreenshotStack(raced.github, input), /changed during validation/)
  })
  it('revokes a deferral when its declaration is removed', async () => {
    const f = fixture()
    f.pulls.set(1, pull(1, LOWER, 'ordinary PR again'))
    f.statuses.set(LOWER, [status('Screenshot review', 5, 'Stack deferred to approved tip #2')])
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.at(-1)?.state, 'pending')
    assert.match(f.writes.at(-1)?.description ?? '', /rerun CI/)
  })
  it('reports invalid live stacks as errors without granting success', async () => {
    const f = fixture()
    f.diverge()
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.at(-1)?.state, 'error')
  })
})

describe('stack coverage attestation', () => {
  const manifest = JSON.stringify({ declaration: TEXT, number: 2, head: TIP, base: BASE })
  it('binds successful source-run coverage to the exact live tip and declaration', async () => {
    const f = fixture()
    await attestScreenshotStack(f.github, tipInput, TIP, manifest)
    assert.equal(f.writes[0]?.context, STACK_COVERAGE)
    assert.equal(f.writes.at(-1)?.sha, TIP)
    assert.equal(f.writes.at(-1)?.description, `Stack coverage ${DIGEST}`)
  })
  it('does not reuse an individual PR review made before combined coverage', async () => {
    const f = fixture()
    f.statuses.set(TIP, [
      status('Screenshot review', 1),
      status(STACK_COVERAGE, 2, `Stack coverage ${DIGEST}`),
    ])
    assert.equal((await verifyScreenshotStack(f.github, tipInput))?.approved, false)
    assert.equal((await attestScreenshotStack(f.github, tipInput, TIP, manifest)).needsReview, true)
  })
  it('requires explicit tip review even when CI found no new candidates', async () => {
    const f = fixture()
    f.statuses.set(TIP, [status('Screenshot review', 1, 'No changed reference screenshots')])
    const result = await attestScreenshotStack(f.github, tipInput, TIP, manifest)
    assert.equal(result.needsReview, true)
    assert.equal(f.writes.at(-1)?.context, 'Screenshot review')
    assert.equal(f.writes.at(-1)?.state, 'pending')
  })
  it('rejects moved heads, edited declarations, wrong PRs, malformed and oversized artifacts', async () => {
    for (const text of [
      '{}',
      'not json',
      ' '.repeat(4097),
      JSON.stringify({ declaration: TEXT, number: 1, head: TIP, base: BASE }),
      JSON.stringify({ declaration: TEXT, number: 2, head: BASE, base: BASE }),
      JSON.stringify({ declaration: TEXT.replace('#1@', '#3@'), number: 2, head: TIP, base: BASE }),
    ]) {
      const f = fixture()
      await assert.rejects(attestScreenshotStack(f.github, tipInput, TIP, text))
      assert.equal(f.writes.length, 0)
    }
    const f = fixture()
    f.pulls.set(2, pull(2, BASE))
    await assert.rejects(attestScreenshotStack(f.github, tipInput, TIP, manifest))
  })
})

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z.array(
        z.object({
          name: z.string().optional(),
          id: z.string().optional(),
          run: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          with: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
  ),
})
describe('stack workflow integration', () => {
  it('forces combined coverage before the screenshot-only shortcut and preserves source-event evidence', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const workflow = workflowSchema.parse(load(ci))
    const steps = workflow.jobs['precheck']?.steps ?? []
    const plan = steps.find((step) => step.id === 'plan')
    assert.equal(plan?.env?.['STACK_TIP'], '${{ steps.screenshot-stack.outputs.tip }}')
    assert.ok(
      (plan.run?.indexOf('Declared screenshot stack tip') ?? Infinity) <
        (plan.run?.indexOf('HEAD commit only refreshes') ?? -1),
    )
    assert.match(
      steps.find((step) => step.name === 'Capture screenshot stack coverage request')?.run ?? '',
      /declaration\.text/,
    )
    assert.equal(
      steps.find((step) => step.name === 'Preserve screenshot stack coverage request')?.with?.[
        'name'
      ],
      'screenshot-stack-coverage-${{ github.run_id }}',
    )
  })
  it('keeps inline workflow JavaScript syntactically valid', () => {
    for (const file of [
      'screenshot-stack',
      'publish-screenshot-candidates',
      'screenshot-review-labels',
      'screenshot-review-selection',
    ]) {
      const workflow = workflowSchema.parse(
        load(readFileSync(`.github/workflows/${file}.yml`, 'utf8')),
      )
      for (const job of Object.values(workflow.jobs))
        for (const step of job.steps) {
          const script = step.with?.['script']
          if (typeof script === 'string')
            assert.doesNotThrow(() => new Script(`(async () => {\n${script}\n})()`))
        }
    }
  })
  it('uses trusted code for coverage publication and re-evaluates after approval and pushes', () => {
    const publisher = readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8')
    assert.match(
      publisher,
      /ref: \$\{\{ github.workflow_sha \}\}[\s\S]*path: screenshot-stack-policy/,
    )
    assert.match(publisher, /stat\.size > 4096/)
    assert.match(publisher, /screenshot-stack-policy\/scripts\/screenshot-stack.mts/)
    const gates = readFileSync('.github/workflows/screenshot-stack.yml', 'utf8')
    assert.match(gates, /pull_request_target:/)
    assert.match(gates, /synchronize/)
    assert.match(gates, /Screenshot review decision, Screenshot review selection/)
    assert.doesNotMatch(gates, /(?:pnpm|npm) (?:install|run)|pull_request.head.sha.*checkout/)
    assert.match(gates, /ref: \$\{\{ github.workflow_sha \}\}/)
  })
})
