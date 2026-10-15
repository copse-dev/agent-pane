import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  classify,
  collectBacklogSnapshot,
  detectBatchReferences,
  detectHoldMarkers,
  detectSelfSupersession,
  formatAge,
  ghApiArguments,
  latestReviewStates,
  parseSince,
  parseSnapshot,
  recordedApi,
  renderBacklogMarkdown,
  summarizeChecks,
  type CollectOptions,
  type PullRecord,
  type Snapshot,
} from './backlog-snapshot.mts'

// Recorded (and trimmed) live responses for eight open and three closed PRs of
// copse-dev/agent-pane on 2026-10-15. Each key is the exact path the collector
// requests, so a changed request shape fails here instead of against GitHub.
const FIXTURE = resolve(import.meta.dirname, 'fixtures/backlog-snapshot/responses.json')
const REPOSITORY = 'copse-dev/agent-pane'
const NOW = new Date('2026-10-15T02:00:00.000Z')
const COMMENTS_PATH = `repos/${REPOSITORY}/issues/comments?sort=updated&direction=desc&since=2026-10-01T02:00:00.000Z&per_page=100&page=1`
type CheckRunInput = Parameters<typeof summarizeChecks>[0][number]

function recorded(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}

function responses(overlay: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...recorded(), ...overlay }).map(([path, value]) => [
      path,
      JSON.stringify(value),
    ]),
  )
}

function options(overrides: Partial<CollectOptions> = {}): CollectOptions {
  return {
    repository: REPOSITORY,
    now: NOW,
    cache: null,
    since: null,
    commentDays: 14,
    limit: 200,
    concurrency: 2,
    ...overrides,
  }
}

function pull(snapshot: Snapshot, number: number): PullRecord {
  const record = snapshot.pulls.find((entry) => entry.number === number)
  assert.ok(record, `PR #${String(number)} missing from snapshot`)
  return record
}

async function collect(
  overlay: Record<string, unknown> = {},
  overrides: Partial<CollectOptions> = {},
): Promise<{ snapshot: Snapshot; requested: string[] }> {
  const api = recordedApi(responses(overlay))
  const snapshot = await collectBacklogSnapshot(api, options(overrides))
  return { snapshot, requested: api.requested }
}

describe('backlog snapshot access', () => {
  it('only ever issues REST GET requests', async () => {
    const { requested } = await collect()
    assert.ok(requested.length > 20)
    for (const path of requested) {
      assert.deepEqual(ghApiArguments(path).slice(0, 3), ['api', '--method', 'GET'])
      assert.ok(path.startsWith(`repos/${REPOSITORY}/`), path)
    }
  })

  it('refuses GraphQL, absolute and traversing paths', () => {
    assert.throws(() => ghApiArguments('graphql'))
    assert.throws(() => ghApiArguments('/repos/x/y'))
    assert.throws(() => ghApiArguments('repos/../x'))
  })

  it('rejects a cache that does not decode as a snapshot', () => {
    assert.equal(parseSnapshot('{"version":2}'), null)
    assert.equal(parseSnapshot('not json'), null)
  })
})

describe('backlog snapshot grouping from recorded responses', () => {
  it('keeps otherwise green work pending when review retrieval fails', async () => {
    const api = recordedApi(responses())
    const reviewPath = `repos/${REPOSITORY}/pulls/3770/reviews?per_page=100`
    const snapshot = await collectBacklogSnapshot(
      {
        get: async (path) => {
          if (path === reviewPath) throw new Error('HTTP 500')
          return api.get(path)
        },
      },
      options(),
    )
    const record = pull(snapshot, 3770)
    assert.equal(record.ci?.conclusion, 'success')
    assert.equal(record.screenshot.state, 'success')
    assert.equal(record.cla.state, 'success')
    assert.deepEqual(record.errors, ['reviews: HTTP 500'])
    assert.equal(record.group, 'in-progress')
    assert.match(record.nextAction, /incomplete observation; retry failed GitHub reads/)
  })

  it('separates ready, failing, visual, hold, superseded and in-progress work', async () => {
    const { snapshot } = await collect()
    assert.equal(snapshot.pulls.length, 8)
    assert.equal(snapshot.truncated, false)

    const ready = pull(snapshot, 3770)
    assert.equal(ready.group, 'ready')
    assert.equal(ready.ci?.conclusion, 'success')
    assert.equal(ready.screenshot.state, 'success')
    assert.equal(ready.mergeable, true)

    const failing = pull(snapshot, 3688)
    assert.equal(failing.group, 'failing-checks')
    assert.equal(failing.ci?.conclusion, 'failure')
    assert.equal(failing.ci.runId, '38142053009')
    assert.ok(failing.failingChecks.some((check) => check.name === 'CI Passed'))
    assert.match(failing.nextAction, /^Fix on current head: CI Passed \(failure, run 38142053009\)/)
    assert.ok(failing.flags.includes('conflicts with main'))

    const visual = pull(snapshot, 3773)
    assert.equal(visual.group, 'missing-visual-decision')
    assert.equal(visual.screenshot.state, 'pending')
    assert.match(visual.nextAction, /36 changed screenshots await review/)

    const hold = pull(snapshot, 3728)
    assert.equal(hold.group, 'acceptance-hold')
    assert.deepEqual(
      hold.holds.map((entry) => [entry.kind, entry.category]),
      [['label', 'review']],
    )

    const vault = pull(snapshot, 3757)
    assert.equal(vault.group, 'acceptance-hold')
    assert.ok(vault.draft)
    assert.ok(
      vault.holds.some(
        (entry) =>
          entry.category === 'security' && /independent security review/.test(entry.evidence),
      ),
    )

    const draft = pull(snapshot, 3777)
    assert.equal(draft.group, 'in-progress')
    assert.ok(draft.flags.includes('draft'))
    assert.equal(draft.ci, null)
  })

  it('ignores superseded CI runs on the same head', async () => {
    // #3742's head carries three CI runs: a cancelled first attempt with a red
    // `CI Passed`, and two later green runs. Only the newest run speaks.
    const { snapshot } = await collect()
    const record = pull(snapshot, 3742)
    assert.equal(record.ci?.conclusion, 'success')
    assert.equal(record.ci.runId, '38525339231')
    assert.deepEqual(record.failingChecks, [])
    assert.equal(record.group, 'in-progress')
    assert.match(record.nextAction, /no Screenshot review status/)
  })

  it('links a pinned original to its batch in both directions, with the batch state', async () => {
    const { snapshot } = await collect()
    const original = pull(snapshot, 2658)
    const batch = pull(snapshot, 3757)
    assert.equal(original.group, 'superseded')
    assert.deepEqual(
      original.supersededBy.map((link) => [link.number, link.kind, link.state]),
      [[3757, 'pinned-head', 'draft']],
    )
    assert.match(original.nextAction, /Folded into open batch #3757 \(draft\)/)
    assert.deepEqual(
      batch.supersedes.map((link) => [link.number, link.kind, link.pinnedSha]),
      [[2658, 'pinned-head', original.headSha]],
    )
    assert.ok(batch.flags.includes('batch of #2658'))
  })

  it('never reads a stacked child as a batch of its parent', async () => {
    // #3777 is based on #3770's branch and says its author "can fold it in".
    const { snapshot } = await collect()
    assert.deepEqual(pull(snapshot, 3770).supersededBy, [])
    assert.deepEqual(pull(snapshot, 3777).supersedes, [])
  })

  it('records merged batches that pin original heads, even closed ones', async () => {
    const { snapshot } = await collect()
    const numbers = snapshot.closedBatches.map((batch) => batch.number)
    assert.deepEqual(numbers, [3775, 3758])
    const settings = snapshot.closedBatches.find((batch) => batch.number === 3758)
    assert.deepEqual(
      settings?.supersedes.map((link) => link.number),
      [3718, 3725, 3726],
    )
    assert.equal(settings.mergeCommit?.length, 40)
  })

  it('reads a self-declared supersession comment and resolves the merged batch', async () => {
    const comments = recorded()[COMMENTS_PATH]
    const existing: unknown[] = Array.isArray(comments) ? comments : []
    assert.ok(existing.length > 0)
    const { snapshot } = await collect({
      [COMMENTS_PATH]: [
        {
          id: 1,
          body: 'Superseded by merged recovery #3758 (05a9b9a4d0a7b4ddf56df21a4c8631d443c6d9c9). Verified the tree.',
          html_url: 'https://github.com/copse-dev/agent-pane/pull/3728#issuecomment-1',
          issue_url: 'https://api.github.com/repos/copse-dev/agent-pane/issues/3728',
          created_at: '2026-10-14T12:00:00Z',
          user: { login: 'maintainer', type: 'User' },
        },
        ...existing,
      ],
    })
    const record = pull(snapshot, 3728)
    assert.equal(record.group, 'superseded')
    assert.deepEqual(
      record.supersededBy.map((link) => [link.number, link.kind, link.state]),
      [[3758, 'self-declared', 'merged']],
    )
    assert.match(record.nextAction, /Verify the changes landed through merged #3758/)
    assert.equal(record.commentEvidence[0]?.kind, 'supersession')
  })

  it('reads screenshot stack membership and tip', async () => {
    const { snapshot } = await collect()
    const member = pull(snapshot, 2658)
    assert.equal(member.stack?.tip, 3698)
    assert.equal(member.stack.isTip, false)
    assert.equal(member.stack.pinMatchesHead, true)
    assert.equal(member.stack.members.length, 7)
    assert.ok(member.flags.includes('stack → #3698'))
  })
})

describe('backlog snapshot cache', () => {
  it('reuses settled observations and refetches only what moved', async () => {
    const first = await collect()
    const second = await collect({}, { cache: first.snapshot })
    assert.ok(second.requested.length < first.requested.length / 3, String(second.requested.length))
    assert.ok(second.snapshot.reused >= 6)
    const reused = pull(second.snapshot, 3770)
    assert.equal(reused.reused, true)
    assert.equal(reused.observedAt, pull(first.snapshot, 3770).observedAt)
    assert.equal(reused.group, 'ready')
    // Derived links are recomputed from fresh bodies even for reused rows.
    assert.equal(pull(second.snapshot, 2658).group, 'superseded')
  })

  it('refetches a PR whose head moved and keeps the previous head as context', async () => {
    const first = await collect()
    const moved = pull(first.snapshot, 3688)
    const stale: Snapshot = {
      ...first.snapshot,
      pulls: first.snapshot.pulls.map((record) =>
        record.number === 3688 ? { ...record, headSha: 'f'.repeat(40) } : record,
      ),
    }
    const second = await collect({}, { cache: stale })
    const record = pull(second.snapshot, 3688)
    assert.equal(record.reused, false)
    assert.equal(record.headSha, moved.headSha)
    assert.equal(record.previousHead?.headSha, 'f'.repeat(40))
    assert.equal(record.previousHead.ci?.conclusion, 'failure')
  })

  it('honours --since by reusing older rows regardless of settledness', async () => {
    const first = await collect()
    const since = new Date('2026-10-15T01:10:00.000Z')
    const second = await collect({}, { cache: first.snapshot, since })
    assert.equal(second.snapshot.since, since.toISOString())
    assert.equal(pull(second.snapshot, 3770).reused, true)
    // #3773 and #3777 were updated after `since`, so they are read again.
    assert.equal(pull(second.snapshot, 3773).reused, false)
    assert.equal(pull(second.snapshot, 3777).reused, false)
  })

  it('parses relative and absolute --since values', () => {
    assert.equal(parseSince(undefined, NOW), null)
    assert.equal(parseSince('6h', NOW)?.toISOString(), '2026-10-14T20:00:00.000Z')
    assert.equal(parseSince('2d', NOW)?.toISOString(), '2026-10-13T02:00:00.000Z')
    assert.equal(parseSince('2026-10-01T00:00:00Z', NOW)?.toISOString(), '2026-10-01T00:00:00.000Z')
    assert.throws(() => parseSince('yesterday', NOW))
  })
})

describe('backlog snapshot rendering', () => {
  it('renders every group, stacks, links and the detection notes', async () => {
    const { snapshot } = await collect()
    const markdown = renderBacklogMarkdown(snapshot)
    for (const heading of [
      '## Ready (1)',
      '## Failing checks (1)',
      '## Missing visual decision (1)',
      '## Substantive acceptance holds (2)',
      '## Superseded originals (1)',
      '## In progress or waiting (2)',
      '## Screenshot stacks (1)',
      '## Supersession links (2)',
      '## How signals are detected',
    ]) {
      assert.ok(markdown.includes(heading), heading)
    }
    assert.match(markdown, /snapshot, not a source of truth/)
    assert.match(
      markdown,
      /\| \[#3770\]\(https:\/\/github\.com\/copse-dev\/agent-pane\/pull\/3770\) \|/,
    )
    assert.match(markdown, /Tip #3698 \(not open\); members #2658 \(pin ok\)/)
    assert.match(markdown, /- merged #3758 .* → #3718, #3725, #3726/)
    // The JSON round-trips through the same decoder the cache uses.
    assert.deepEqual(parseSnapshot(JSON.stringify(snapshot)), snapshot)
  })

  it('formats head age compactly', () => {
    assert.equal(formatAge('2026-10-15T01:45:00Z', NOW), '15m')
    assert.equal(formatAge('2026-10-14T20:00:00Z', NOW), '6h')
    assert.equal(formatAge('2026-10-12T20:00:00Z', NOW), '2d 6h')
    assert.equal(formatAge(null, NOW), '?')
  })
})

describe('backlog snapshot heuristics', () => {
  it('pins original heads and reads recovery clauses conservatively', () => {
    const body = [
      'Recovers #3462 independently on main `57a50b6df3210437c107b9e57bc8fe2eb9aee432`.',
      'Original heads remain preserved:',
      '- #3718: `5c1570c24eaafe1139b86d3ee3f57832b03884c2`',
      '| #3755 | fa1e53e84fba016307a0b954e075701cedc473ca |',
      'Excluded: draft vault #3757 and draft worktree recovery #3761.',
      "Step 0 of landing the plan, based on its branch so #3770's author can fold it in.",
      'Integrate the eight security/runtime recoveries on current main.',
      'It delivers item 2 of the recovery throughput plan (#3770): an audit of CI.',
    ].join('\n')
    const references = detectBatchReferences(body, 3760)
    assert.deepEqual(
      references.map((reference) => [
        reference.number,
        reference.kind,
        reference.pinnedSha ?? null,
      ]),
      [
        [3718, 'pinned-head', '5c1570c24eaafe1139b86d3ee3f57832b03884c2'],
        [3755, 'pinned-head', 'fa1e53e84fba016307a0b954e075701cedc473ca'],
        [3462, 'recovery-clause', null],
      ],
    )
    assert.deepEqual(detectBatchReferences('Recovers #42 on main.', 42), [])
  })

  it('reads supersession wording written on the original', () => {
    assert.deepEqual(
      detectSelfSupersession(
        'Superseded by cumulative Settings recovery #3758, merged as 05a9b9a.',
      ).map((found) => found.number),
      [3758],
    )
    assert.deepEqual(
      detectSelfSupersession('Folded into #12 and retired in #13').map((f) => f.number),
      [12, 13],
    )
    assert.deepEqual(detectSelfSupersession('This supersedes #9'), [])
  })

  it('detects explicit hold wording and skips lifted holds and quotes', () => {
    const holds = detectHoldMarkers(
      [
        'Keep draft. Obtain independent security review.',
        'Complete the remaining native/profile-vault acceptance on a Mac.',
        'Validation is no longer a pre-merge acceptance blocker.',
        '**HOLD:** supported-platform acceptance remains.',
        'Landing awaits the owner’s decision on the queue path.',
        'Nothing holds this up.',
      ].join('\n'),
    )
    assert.deepEqual(
      holds.map((hold) => hold.category),
      ['security', 'native', 'product'],
    )
    assert.match(holds[1]?.evidence ?? '', /HOLD/)
  })

  it('keeps only each reviewer’s latest decisive review', () => {
    const states = latestReviewStates([
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-10-01T00:00:00Z',
        user: { login: 'a', type: 'User' },
      },
      {
        id: 2,
        state: 'COMMENTED',
        submitted_at: '2026-10-02T00:00:00Z',
        user: { login: 'a', type: 'User' },
      },
      {
        id: 3,
        state: 'APPROVED',
        submitted_at: '2026-10-03T00:00:00Z',
        user: { login: 'b', type: 'User' },
      },
      {
        id: 4,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-10-01T00:00:00Z',
        user: { login: 'b', type: 'User' },
      },
      { id: 5, state: 'APPROVED', submitted_at: null, user: null },
    ])
    assert.deepEqual(states, { changesRequestedBy: ['a'], approvedBy: ['b'] })
  })

  it('keeps the newest check per name and drops jobs of superseded CI runs', () => {
    const run = (
      id: number,
      name: string,
      conclusion: string | null,
      runId: number,
      status = 'completed',
    ): CheckRunInput => ({
      id,
      name,
      status,
      conclusion,
      html_url: `https://github.com/copse-dev/agent-pane/actions/runs/${String(runId)}/job/${String(id)}`,
      details_url: null,
      output: { title: null },
    })
    const summary = summarizeChecks([
      run(10, 'CI Passed', 'failure', 1),
      run(9, 'e2e (1)', 'failure', 1),
      run(8, 'bench', 'cancelled', 1),
      run(20, 'CI Passed', 'success', 2),
      run(19, 'e2e (1)', 'success', 2),
      run(18, 'lint', 'failure', 2),
      run(17, 'slow', null, 2, 'in_progress'),
      run(30, 'Evaluate base freshness', 'cancelled', 3),
      run(31, 'Base Current', 'neutral', 4),
    ])
    assert.equal(summary.ci?.runId, '2')
    assert.deepEqual(
      summary.failingChecks.map((check) => check.name),
      ['lint'],
    )
    assert.equal(summary.pendingChecks, 1)
    assert.equal(summary.baseCurrent?.conclusion, 'neutral')
  })

  it('counts a cancelled job only inside the newest CI run', () => {
    const run = (id: number, name: string, conclusion: string, runId: number): CheckRunInput => ({
      id,
      name,
      status: 'completed',
      conclusion,
      html_url: `https://github.com/copse-dev/agent-pane/actions/runs/${String(runId)}/job/${String(id)}`,
      details_url: null,
      output: { title: null },
    })
    const summary = summarizeChecks([
      run(2, 'CI Passed', 'failure', 7),
      run(1, 'e2e (3)', 'cancelled', 7),
    ])
    assert.deepEqual(
      summary.failingChecks.map((check) => check.name),
      ['CI Passed', 'e2e (3)'],
    )
  })

  it('classifies a changes-requested review as a hold ahead of a visual decision', async () => {
    const { snapshot } = await collect()
    const base = pull(snapshot, 3773)
    const held = classify({
      ...base,
      changesRequestedBy: ['reviewer'],
      holds: [
        {
          kind: 'changes-requested',
          category: 'review',
          evidence: 'changes requested by reviewer',
        },
      ],
    })
    assert.equal(held.group, 'acceptance-hold')
    assert.ok(held.flags.includes('screenshots await decision'))
    assert.ok(held.flags.includes('hold: review'))
  })
})
