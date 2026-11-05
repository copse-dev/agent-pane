import { Script } from 'node:vm'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'
import {
  attestScreenshotStack,
  memoizeScreenshotStackAncestry,
  parseScreenshotStack,
  reconcileScreenshotStack,
  selectScreenshotStackCompletion,
  selectScreenshotStackPulls,
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
/** GitHub's combined-status endpoint uses status-simple, which omits creator. */
function compactStatus(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object')
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'creator'))
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
  it('hydrates creator-less current statuses without walking unrelated history and observes revocation', async () => {
    const f = fixture()
    let reads = 0
    let historyReads = 0
    f.github.rest.repos.listCommitStatusesForRef = async ({
      ref,
      page,
    }): Promise<{ data: unknown }> => {
      assert.equal(page, 1, 'current proof is found on the first history page')
      historyReads += 1
      return {
        data: [
          ...(f.statuses.get(ref) ?? []),
          ...Array.from({ length: 97 }, (_, i) => status(`Other ${String(i)}`, 100 + i)),
        ],
      }
    }
    f.github.rest.repos.getCombinedStatusForRef = async ({
      ref,
      page,
    }): Promise<{ data: unknown }> => {
      assert.equal(page, 1)
      reads += 1
      return { data: { statuses: (f.statuses.get(ref) ?? []).map(compactStatus) } }
    }
    const policy = memoizeScreenshotStackAncestry(f.github)
    assert.equal((await verifyScreenshotStack(policy, input))?.approved, true)
    f.statuses.set(TIP, [status('Screenshot review', 4, 'Review revoked', 'error')])
    assert.equal((await verifyScreenshotStack(policy, input))?.approved, false)
    assert.equal(reads, 2, 'decision reads remain live despite shared immutable ancestry')
    assert.equal(historyReads, 2, 'hydrate only the current proof, not unrelated status history')
  })
  it('rejects untrusted creators even when compact status states and declaration digests match', async () => {
    for (const context of ['Screenshot review', STACK_COVERAGE, STACK_DECISION]) {
      const f = fixture()
      f.statuses.set(TIP, [
        status(
          'Screenshot review',
          1,
          undefined,
          'success',
          context === 'Screenshot review' ? 123 : 41898282,
        ),
        status(
          STACK_COVERAGE,
          2,
          `Stack coverage ${DIGEST}`,
          'success',
          context === STACK_COVERAGE ? 123 : 41898282,
        ),
        status(
          STACK_DECISION,
          3,
          `Stack decision ${DIGEST}`,
          'success',
          context === STACK_DECISION ? 123 : 41898282,
        ),
      ])
      f.github.rest.repos.getCombinedStatusForRef = async ({
        ref,
      }): Promise<{ data: unknown }> => ({
        data: { statuses: (f.statuses.get(ref) ?? []).map(compactStatus) },
      })
      assert.equal((await verifyScreenshotStack(f.github, input))?.approved, false)
    }
  })
  it('observes a newer revocation while hydrating creator identity', async () => {
    const f = fixture()
    const snapshot = (f.statuses.get(TIP) ?? []).map(compactStatus)
    f.github.rest.repos.getCombinedStatusForRef = async (): Promise<{ data: unknown }> => ({
      data: { statuses: snapshot },
    })
    f.statuses.set(TIP, [
      status('Screenshot review', 4, 'Review revoked during hydration', 'error'),
      ...(f.statuses.get(TIP) ?? []),
    ])
    assert.equal((await verifyScreenshotStack(f.github, input))?.approved, false)
  })
  it('fails closed when full statuses cannot resolve the current status IDs', async () => {
    const f = fixture()
    f.github.rest.repos.getCombinedStatusForRef = async ({ ref }): Promise<{ data: unknown }> => ({
      data: { statuses: (f.statuses.get(ref) ?? []).map(compactStatus) },
    })
    f.github.rest.repos.listCommitStatusesForRef = async (): Promise<{ data: unknown }> => ({
      data: [],
    })
    await assert.rejects(verifyScreenshotStack(f.github, input), /creators unavailable/)
  })
  it('paginates current contexts and fails closed for malformed combined responses', async () => {
    const f = fixture()
    const pages: number[] = []
    f.github.rest.repos.getCombinedStatusForRef = async ({
      ref,
      page,
    }): Promise<{ data: unknown }> => {
      pages.push(page)
      return {
        data: {
          statuses:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => status(`Other ${String(i)}`, 100 + i))
              : (f.statuses.get(ref) ?? []),
        },
      }
    }
    assert.equal((await verifyScreenshotStack(f.github, input))?.approved, true)
    assert.deepEqual(pages, [1, 2])
    f.github.rest.repos.getCombinedStatusForRef = async (): Promise<{ data: unknown }> => ({
      data: {},
    })
    await assert.rejects(verifyScreenshotStack(f.github, input), /statuses unavailable/)
  })
  it('shares immutable ancestry comparisons across a ten-PR stack, not live proof', async () => {
    const f = fixture()
    const sha = (number: number): string => number.toString(16).padStart(40, '0')
    const text = `<!-- copse-screenshot-stack: ${Array.from({ length: 9 }, (_, i) => `#${String(i + 1)}@${sha(i + 1)}`).join(' ')} tip=#10 -->`
    const parsed = parseScreenshotStack(text)
    assert.ok(parsed)
    for (let number = 1; number <= 10; number += 1) {
      f.pulls.set(number, pull(number, sha(number), text))
    }
    f.statuses.set(sha(10), [
      status('Screenshot review', 1),
      status(STACK_COVERAGE, 2, `Stack coverage ${parsed.digest}`),
      status(STACK_DECISION, 3, `Stack decision ${parsed.digest}`),
    ])
    let comparisons = 0
    const compare = f.github.rest.repos.compareCommitsWithBasehead.bind(f.github.rest.repos)
    f.github.rest.repos.compareCommitsWithBasehead = async (
      request,
    ): Promise<{ data: unknown }> => {
      comparisons += 1
      return compare(request)
    }
    const cached = memoizeScreenshotStackAncestry(f.github)
    for (let number = 1; number <= 10; number += 1) {
      assert.equal((await verifyScreenshotStack(cached, { ...input, number }))?.approved, true)
    }
    assert.equal(comparisons, 17, 'one query per immutable ancestry pair, rather than 170')
    f.statuses.set(sha(10), [status('Screenshot review', 4, 'Review revoked', 'error')])
    assert.equal((await verifyScreenshotStack(cached, { ...input, number: 10 }))?.approved, false)
    f.pulls.set(3, pull(3, BASE, text))
    await assert.rejects(
      verifyScreenshotStack(cached, { ...input, number: 10 }),
      /head or declaration changed/,
    )
  })
  it('does not append duplicate trusted statuses and returns the verified outcome', async () => {
    const f = fixture()
    const description = `Stack deferred to approved tip #2 at ${TIP.slice(0, 12)}`
    f.statuses.set(LOWER, [status('Screenshot review', 4, description)])
    assert.deepEqual(await reconcileScreenshotStack(f.github, input), {
      head: LOWER,
      state: 'success',
      description,
    })
    assert.deepEqual(f.writes, [])
    f.statuses.set(LOWER, [status('Screenshot review', 5, description, 'success', 123)])
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.length, 1, 'an untrusted lookalike must be replaced')
  })
  it('keeps racing-push checks live when ancestry results are already cached', async () => {
    const f = fixture()
    const cached = memoizeScreenshotStackAncestry(f.github)
    await verifyScreenshotStack(cached, tipInput)
    const get = f.github.rest.pulls.get.bind(f.github.rest.pulls)
    let lowerReads = 0
    f.github.rest.pulls.get = async (request): Promise<{ data: unknown }> => {
      const result = await get(request)
      if (request.pull_number === 1 && ++lowerReads === 1) f.pulls.set(1, pull(1, BASE))
      return result
    }
    await assert.rejects(verifyScreenshotStack(cached, tipInput), /changed during validation/)
  })
  it('does not grow pending status history while the tip is still awaiting review', async () => {
    const f = fixture()
    f.statuses.set(TIP, [])
    const description = 'Stack waiting for covered screenshot approval on tip #2'
    f.statuses.set(LOWER, [status('Screenshot review', 4, description, 'pending')])
    assert.equal((await reconcileScreenshotStack(f.github, input))?.state, 'pending')
    assert.deepEqual(f.writes, [])
  })
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
  it('leaves ordinary PR screenshot checks untouched', async () => {
    const f = fixture()
    f.pulls.set(1, pull(1, LOWER, 'ordinary PR'))
    await reconcileScreenshotStack(f.github, input)
    assert.deepEqual(f.writes, [])
  })
  it('names the moved PR instead of reporting a generic invalid stack', async () => {
    const f = fixture()
    f.pulls.set(1, pull(1, BASE))
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.at(-1)?.state, 'error')
    assert.match(f.writes.at(-1)?.description ?? '', /PR #1 head moved; update its stack pin/)
  })
  it('clears a resolved tip setup error without granting screenshot approval', async () => {
    const f = fixture()
    f.statuses.set(TIP, [status('Screenshot review', 4, 'Stack invalid or changed', 'error')])
    await reconcileScreenshotStack(f.github, tipInput)
    assert.equal(f.writes.at(-1)?.state, 'pending')
    assert.match(f.writes.at(-1)?.description ?? '', /waiting for combined CI/)
  })
  it('preserves an explicit tip decision during reconciliation', async () => {
    const f = fixture()
    await reconcileScreenshotStack(f.github, tipInput)
    assert.deepEqual(f.writes, [])
  })
  it('does not publish raw API errors as a declaration problem', async () => {
    const f = fixture()
    f.github.rest.repos.compareCommitsWithBasehead = async (): Promise<never> => {
      throw new Error('private response details')
    }
    await reconcileScreenshotStack(f.github, input)
    assert.equal(f.writes.at(-1)?.state, 'error')
    assert.match(f.writes.at(-1)?.description ?? '', /Validation unavailable/)
    assert.doesNotMatch(f.writes.at(-1)?.description ?? '', /private response/)
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
  it('preserves an explicit tip decision while refreshing creator-less combined coverage', async () => {
    const f = fixture()
    f.github.rest.repos.getCombinedStatusForRef = async ({ ref }): Promise<{ data: unknown }> => ({
      data: { statuses: (f.statuses.get(ref) ?? []).map(compactStatus) },
    })
    const result = await attestScreenshotStack(f.github, tipInput, TIP, manifest)
    assert.equal(result.needsReview, false)
    assert.deepEqual(
      f.writes.map((write) => write.context),
      [STACK_COVERAGE],
    )
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
describe('incremental screenshot stack selection', () => {
  it('bounds ordinary-PR reconciliation to two API reads in a 50-PR repository', async () => {
    const f = fixture()
    const open = Array.from({ length: 50 }, (_, index) => pull(index + 1, BASE, ''))
    let reads = 0
    f.github.rest.pulls.get = async ({ pull_number }): Promise<{ data: unknown }> => {
      assert.equal(pull_number, 50, 'unrelated PRs must not be validated')
      reads++
      return { data: open[49] }
    }
    f.github.rest.repos.listCommitStatusesForRef = async (): Promise<{ data: unknown }> => {
      reads++
      return { data: [] }
    }
    for (const number of selectScreenshotStackPulls(open, 'pull_request_target', {
      pull_request: open[49],
    }))
      await reconcileScreenshotStack(f.github, { ...input, number })
    assert.equal(reads, 2, 'excludes the single paginated open-PR discovery request')
    assert.equal(f.writes.length, 0)
  })
  const other = `<!-- copse-screenshot-stack: #3@${BASE} tip=#4 -->`
  const open = [
    pull(1, LOWER),
    pull(2, TIP),
    pull(3, BASE, other),
    pull(4, BASE, other),
    pull(5, BASE, ''),
  ]
  it('selects one ordinary PR without validating unrelated stacks', () => {
    assert.deepEqual(
      selectScreenshotStackPulls(open, 'pull_request_target', {
        pull_request: pull(5, BASE, ''),
      }),
      [5],
    )
  })
  it('selects the connected stack for a lower push or tip approval', () => {
    for (const number of [1, 2])
      assert.deepEqual(
        selectScreenshotStackPulls(open, 'pull_request_target', {
          pull_request: pull(number, TIP),
        }),
        [1, 2],
      )
    assert.deepEqual(
      selectScreenshotStackPulls(open, 'workflow_run', {
        workflow_run: { pull_requests: [{ number: 2 }] },
      }),
      [1, 2],
    )
  })
  it('revokes removed declarations and follows the old membership', () => {
    const removed = [pull(1, LOWER, ''), pull(2, TIP, ''), ...open.slice(2)]
    assert.deepEqual(
      selectScreenshotStackPulls(removed, 'pull_request_target', {
        pull_request: pull(1, LOWER, ''),
        changes: { body: { from: TEXT } },
      }),
      [1, 2],
    )
  })
  it('follows old and new membership transitively', () => {
    const moved = [pull(1, LOWER, other), ...open.slice(1)]
    assert.deepEqual(
      selectScreenshotStackPulls(moved, 'pull_request_target', {
        pull_request: pull(1, LOWER, other),
        changes: { body: { from: TEXT } },
      }),
      [1, 2, 3, 4],
    )
  })
  it('invalidates dependents of a closed tip absent from the open list', () => {
    assert.deepEqual(
      selectScreenshotStackPulls(
        open.filter((_, index) => index !== 1),
        'pull_request_target',
        {
          pull_request: { number: 2, body: '' },
        },
      ),
      [1],
    )
  })
  it('includes malformed declarations for live error validation', () => {
    const broken = [pull(1, LOWER, `<!-- copse-screenshot-stack: broken #2`), ...open.slice(1)]
    assert.deepEqual(
      selectScreenshotStackPulls(broken, 'workflow_run', {
        workflow_run: { pull_requests: [{ number: 2 }] },
      }),
      [1, 2],
    )
  })
  it('uses matching heads and falls back when workflow association is unavailable', () => {
    assert.deepEqual(
      selectScreenshotStackPulls(open, 'workflow_run', {
        workflow_run: { head_sha: TIP, pull_requests: [] },
      }),
      [1, 2],
    )
    for (const payload of [{}, { workflow_run: { head_sha: 'unknown', pull_requests: [] } }]) {
      assert.deepEqual(selectScreenshotStackPulls(open, 'workflow_run', payload), [1, 2, 3, 4, 5])
    }
  })
  it('performs complete manual/scheduled repair and handles invalid event numbers', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'unknown', 'pull_request_target']) {
      assert.deepEqual(selectScreenshotStackPulls(open, event, {}), [1, 2, 3, 4, 5])
    }
  })
  it('selects the same dependency closure independently of list order', () => {
    const payload = { pull_request: pull(1, LOWER, other), changes: { body: { from: TEXT } } }
    assert.deepEqual(
      selectScreenshotStackPulls([...open].reverse(), 'pull_request_target', payload).sort(),
      [1, 2, 3, 4],
    )
  })

  describe('unassociated workflow completions', () => {
    // Publisher, decision and selection runs complete on main: no PR metadata,
    // and a head SHA that matches no open PR.
    const MAIN = 'f'.repeat(40)
    const THIRD = 'd'.repeat(40)
    const FOURTH = 'e'.repeat(40)
    const STARTED = '2026-10-14T20:00:00Z'
    const payload = {
      workflow_run: { head_sha: MAIN, pull_requests: [], run_started_at: STARTED },
    }
    const repository = { owner: 'copse-dev', repo: 'agent-pane' }
    const stacks = [
      pull(1, LOWER),
      pull(2, TIP),
      pull(3, THIRD, other),
      pull(4, FOURTH, other),
      pull(5, BASE, ''),
    ]
    function written(context: string, at: string): Record<string, unknown> {
      return { ...status(context, 1), created_at: at, updated_at: at }
    }
    function reads(
      statuses: Map<string, unknown>,
      combined = false,
    ): { github: StackGitHub; refs: string[]; pulls: number } {
      const refs: string[] = []
      const read = async ({ ref }: { ref: string }): Promise<{ data: unknown }> => {
        refs.push(ref)
        const data = statuses.get(ref) ?? []
        return { data: combined ? { statuses: data } : data }
      }
      const github: StackGitHub = {
        rest: {
          pulls: {
            get: async (): Promise<{ data: unknown }> => {
              result.pulls++
              return { data: undefined }
            },
          },
          repos: {
            compareCommitsWithBasehead: async (): Promise<never> =>
              assert.fail('selection never compares'),
            listCommitStatusesForRef: combined
              ? async (): Promise<never> => assert.fail('the combined endpoint was available')
              : read,
            ...(combined ? { getCombinedStatusForRef: read } : {}),
            createCommitStatus: async (): Promise<never> => assert.fail('selection never writes'),
          },
        },
      }
      const result = { github, refs, pulls: 0 }
      return result
    }
    it('reads only declared heads and selects the stack whose evidence changed', async () => {
      const f = reads(
        new Map<string, unknown>([
          [LOWER, [written('Screenshot review', '2026-10-14T20:00:05Z')]],
          [TIP, [written('Screenshot review', '2026-10-14T19:00:00Z')]],
          [FOURTH, [written(STACK_DECISION, '2026-10-14T19:59:59Z')]],
        ]),
      )
      assert.deepEqual(
        await selectScreenshotStackCompletion(f.github, repository, stacks, payload),
        [1, 2],
      )
      assert.deepEqual(f.refs.sort(), [LOWER, TIP, THIRD, FOURTH].sort(), 'ordinary heads unread')
      assert.equal(f.pulls, 0)
    })
    it('selects nothing when no declared head changed, and only on evidence contexts', async () => {
      for (const statuses of [
        new Map<string, unknown>(),
        new Map<string, unknown>([[LOWER, [written('ci/lint', '2026-10-14T20:00:05Z')]]]),
        new Map<string, unknown>([[TIP, [written(STACK_COVERAGE, '2026-10-14T19:59:59Z')]]]),
        new Map<string, unknown>([[BASE, [written('Screenshot review', '2026-10-14T20:00:05Z')]]]),
      ]) {
        const f = reads(statuses)
        assert.deepEqual(
          await selectScreenshotStackCompletion(f.github, repository, stacks, payload),
          [],
        )
      }
    })
    it('treats tip approval evidence as a change for the whole stack', async () => {
      for (const context of ['Screenshot review', STACK_COVERAGE, STACK_DECISION]) {
        const f = reads(new Map<string, unknown>([[FOURTH, [written(context, STARTED)]]]))
        assert.deepEqual(
          await selectScreenshotStackCompletion(f.github, repository, stacks, payload),
          [3, 4],
        )
      }
    })
    it('uses the combined endpoint when available and selects a full first page', async () => {
      const f = reads(
        new Map<string, unknown>([[THIRD, [written(STACK_DECISION, '2026-10-14T20:00:01Z')]]]),
        true,
      )
      assert.deepEqual(
        await selectScreenshotStackCompletion(f.github, repository, stacks, payload),
        [3, 4],
      )
      const full = reads(
        new Map<string, unknown>([
          [LOWER, Array.from({ length: 100 }, () => written('ci/lint', '2026-01-01T00:00:00Z'))],
        ]),
        true,
      )
      assert.deepEqual(
        await selectScreenshotStackCompletion(full.github, repository, stacks, payload),
        [1, 2],
      )
    })
    it('validates rather than guesses for unreadable statuses, undated writes or bad heads', async () => {
      const unreadable = reads(new Map<string, unknown>([[LOWER, 'unavailable']]))
      assert.deepEqual(
        await selectScreenshotStackCompletion(unreadable.github, repository, stacks, payload),
        [1, 2],
      )
      const undated = reads(new Map<string, unknown>([[TIP, [status('Screenshot review', 1)]]]))
      assert.deepEqual(
        await selectScreenshotStackCompletion(undated.github, repository, stacks, payload),
        [1, 2],
      )
      const f = reads(new Map<string, unknown>())
      const broken = [...stacks]
      broken[2] = { ...pull(3, THIRD, other), head: { sha: 'main' } }
      assert.deepEqual(
        await selectScreenshotStackCompletion(f.github, repository, broken, payload),
        [3, 4],
      )
      assert.ok(!f.refs.includes('main'))
    })
    it('keeps the full sweep when the completion carries no usable timestamp', async () => {
      for (const run of [
        { head_sha: MAIN, pull_requests: [] },
        { head_sha: MAIN, pull_requests: [], run_started_at: 'yesterday' },
        { head_sha: MAIN, pull_requests: [], run_started_at: 20 },
      ]) {
        const f = reads(new Map<string, unknown>())
        assert.deepEqual(
          await selectScreenshotStackCompletion(f.github, repository, stacks, {
            workflow_run: run,
          }),
          [1, 2, 3, 4, 5],
        )
        assert.equal(f.refs.length, 0)
      }
      const created = reads(
        new Map<string, unknown>([[LOWER, [written('Screenshot review', STARTED)]]]),
      )
      assert.deepEqual(
        await selectScreenshotStackCompletion(created.github, repository, stacks, {
          workflow_run: { head_sha: MAIN, pull_requests: [], created_at: STARTED },
        }),
        [1, 2],
      )
    })
    it('routes associated completions without reading any status', async () => {
      for (const run of [
        { pull_requests: [{ number: 3 }], run_started_at: STARTED },
        { head_sha: FOURTH, pull_requests: [], run_started_at: STARTED },
      ]) {
        const f = reads(
          new Map<string, unknown>([[LOWER, [written('Screenshot review', STARTED)]]]),
        )
        assert.deepEqual(
          await selectScreenshotStackCompletion(f.github, repository, stacks, {
            workflow_run: run,
          }),
          [3, 4],
        )
        assert.equal(f.refs.length, 0)
      }
    })
    it('bounds an ordinary-PR publication to one read per declared head', async () => {
      const f = reads(new Map<string, unknown>())
      const open = [
        ...stacks,
        ...Array.from({ length: 45 }, (_, index) => pull(10 + index, BASE, '')),
      ]
      assert.deepEqual(
        await selectScreenshotStackCompletion(f.github, repository, open, payload),
        [],
      )
      assert.equal(f.refs.length, 4, 'four declared heads, forty-six ordinary PRs unread')
    })
  })
})
describe('stack workflow integration', () => {
  it('coalesces pending triggers and repairs all live PRs without event history', async () => {
    const source = readFileSync('.github/workflows/screenshot-stack.yml', 'utf8')
    const routing = z
      .object({
        concurrency: z.object({
          group: z.string(),
          queue: z.never().optional(),
          'cancel-in-progress': z.literal(false),
        }),
        on: z.object({ schedule: z.array(z.object({ cron: z.string() })) }),
        jobs: z.object({ reconcile: z.object({ if: z.string() }) }),
      })
      .parse(load(source))
    assert.equal(routing.on.schedule.length, 1)
    const group = (eventName: string, headRepo: string): unknown =>
      new Script(routing.concurrency.group.slice(3, -2)).runInNewContext({
        github: {
          repository: 'copse-dev/agent-pane',
          event_name: eventName,
          event: { pull_request: { head: { repo: { full_name: headRepo } } } },
        },
      })
    assert.equal(group('pull_request_target', 'copse-dev/agent-pane'), 'screenshot-stack-policy')
    assert.equal(group('workflow_run', ''), 'screenshot-stack-policy')
    assert.equal(group('schedule', ''), 'screenshot-stack-policy')
    assert.notEqual(group('pull_request_target', 'someone/fork'), 'screenshot-stack-policy')
    assert.match(routing.jobs.reconcile.if, /head\.repo\.full_name == github\.repository/)
    const workflow = workflowSchema.parse(load(source))
    const script = workflow.jobs['reconcile']?.steps.find(
      (step) => step.name === 'Reconcile live screenshot stacks',
    )?.with?.['script']
    assert.ok(typeof script === 'string')
    const start = script.indexOf('const { owner, repo }')
    assert.ok(start >= 0)
    const f = fixture()
    f.pulls.set(3, pull(3, BASE, 'declaration removed in a superseded event'))
    const otherHead = 'd'.repeat(40)
    f.pulls.set(4, pull(4, otherHead, '<!-- copse-screenshot-stack: malformed -->'))
    f.pulls.set(5, {
      ...pull(5, 'e'.repeat(40)),
      head: { sha: 'e'.repeat(40), repo: { full_name: 'someone/fork' } },
    })
    for (const pr of f.pulls.values()) pr['labels'] = []
    f.statuses.set(BASE, [status('Screenshot review', 10, 'Stack deferred to approved tip')])
    const comments = new Map<number, { id: number; body: string; user: { id: number } }>()
    let commentWrites = 0
    const write = f.github.rest.repos.createCommitStatus.bind(f.github.rest.repos)
    f.github.rest.repos.createCommitStatus = async (value): Promise<void> => {
      await write(value)
      f.statuses.set(value.sha, [
        status(value.context, 20 + f.writes.length, value.description, value.state),
        ...(f.statuses.get(value.sha) ?? []).filter(
          (entry) => z.object({ context: z.string() }).parse(entry).context !== value.context,
        ),
      ])
    }
    const github = {
      rest: {
        ...f.github.rest,
        pulls: {
          ...f.github.rest.pulls,
          list: async (): Promise<{ data: unknown[] }> => ({ data: [...f.pulls.values()] }),
        },
        issues: {
          listComments: async (): Promise<{ data: unknown[] }> => ({ data: [] }),
          createComment: async ({
            issue_number,
            body,
          }: {
            issue_number: number
            body: string
          }): Promise<void> => {
            commentWrites += 1
            comments.set(issue_number, { id: issue_number, body, user: { id: 41898282 } })
          },
          updateComment: async (): Promise<void> => {
            commentWrites += 1
          },
        },
      },
      paginate: async (method: unknown, args: { issue_number?: number }): Promise<unknown[]> => {
        if (method === github.rest.pulls.list) return [...f.pulls.values()]
        assert.equal(method, github.rest.issues.listComments)
        return [comments.get(args.issue_number ?? -1)].filter(Boolean)
      },
    }
    const run = async (eventName: string, payload: unknown): Promise<void> => {
      await new Script(`(async () => {\n${script.slice(start)}\n})()`).runInNewContext({
        github,
        memoizeScreenshotStackAncestry,
        reconcileScreenshotStack,
        parseScreenshotStack,
        core: { info: (): void => {} },
        context: { repo: { owner: 'copse-dev', repo: 'agent-pane' }, eventName, payload },
      })
    }
    // Only this unrelated trusted trigger survives; no earlier payloads remain.
    // Fork PRs in the live list must still be excluded from reconciliation.
    await run('pull_request_target', { pull_request: f.pulls.get(4) })
    assert.deepEqual(
      f.writes.map(({ sha }) => sha),
      [LOWER, BASE, otherHead],
    )
    assert.equal(f.writes[0]?.state, 'success')
    assert.match(f.writes[1]?.description ?? '', /Stack removed/)
    assert.equal(f.writes[2]?.state, 'error')
    assert.equal(commentWrites, 3)
    assert.equal(comments.has(2), false, 'explicit tip decision remains untouched')
    await run('workflow_run', { workflow_run: { head_sha: otherHead, pull_requests: [] } })
    assert.equal(f.writes.length, 3, 'unchanged sweep adds no statuses')
    assert.equal(commentWrites, 3, 'unchanged sweep adds no comments')
  })
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
