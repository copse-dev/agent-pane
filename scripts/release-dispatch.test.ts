import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CI_PENDING_STEP,
  CI_WORKFLOW,
  RELEASE_DISPATCH_CONTEXT,
  RELEASE_PREFLIGHT_JOB,
  RELEASE_WORKFLOW,
  ciFinished,
  newestCiRun,
  releaseTagAt,
  startReleaseBuild,
  startReleaseWhenCiFinished,
  type CiRun,
  type ReleaseDispatchContext,
  type ReleaseDispatchGitHub,
} from './release-dispatch.mts'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const ACTIONS_BOT = { id: 41898282, login: 'github-actions[bot]' }
/** The CI result most tests act on: run 70, first attempt, finished. */
const CI: CiRun = { id: 70, attempt: 1, status: 'completed' }
const CI_KEY = 'https://github.com/copse-dev/agent-pane/actions/runs/70/attempts/1'

interface Status {
  context: string
  state: string
  description?: string
  target_url: string
  creator: { id: number; login: string }
}

interface Fake {
  version?: unknown
  packageJson?: string | null
  ref?: unknown
  refError?: { status: number }
  tagObject?: unknown
  runs?: unknown
  jobs?: Record<number, unknown>
  ciRuns?: unknown
  ciError?: { status: number }
  /** The commit's statuses, shared between contexts to model later evaluations. */
  statuses?: Status[]
  statusWriteError?: boolean
}

interface Calls {
  refs: string[]
  tags: string[]
  dispatches: { workflow_id: string; ref: string; inputs: { tag: string } }[]
  runLookups: { workflow_id: string; head_sha: string; event?: string }[]
  jobLookups: number[]
}

function context(fake: Fake): {
  ctx: ReleaseDispatchContext
  calls: Calls
  logs: string[]
  statuses: Status[]
} {
  const calls: Calls = { refs: [], tags: [], dispatches: [], runLookups: [], jobLookups: [] }
  const logs: string[] = []
  const statuses = fake.statuses ?? []
  const text =
    fake.packageJson === undefined
      ? JSON.stringify({ name: 'copse-panel', version: fake.version ?? '1.2.3-beta.4' })
      : fake.packageJson
  const github: ReleaseDispatchGitHub = {
    rest: {
      repos: {
        getContent: ({ path, ref }) => {
          assert.equal(path, 'package.json')
          assert.equal(ref, SHA, 'the version must be read at the release commit')
          return Promise.resolve({
            data: text === null ? [] : { content: Buffer.from(text).toString('base64') },
          })
        },
        listCommitStatusesForRef: ({ ref }) => {
          assert.equal(ref, SHA)
          // Newest first, as the API returns them.
          return Promise.resolve({ data: [...statuses].reverse() })
        },
        createCommitStatus: ({ sha, state, context: name, description, target_url }) => {
          assert.equal(sha, SHA)
          if (fake.statusWriteError) return Promise.reject(new Error('status API'))
          statuses.push({ context: name, state, description, target_url, creator: ACTIONS_BOT })
          return Promise.resolve({})
        },
      },
      git: {
        getRef: ({ ref }) => {
          calls.refs.push(ref)
          if (fake.refError) return Promise.reject(Object.assign(new Error('API'), fake.refError))
          return Promise.resolve({ data: fake.ref ?? { object: { type: 'commit', sha: SHA } } })
        },
        getTag: ({ tag_sha }) => {
          calls.tags.push(tag_sha)
          return Promise.resolve({ data: fake.tagObject })
        },
      },
      actions: {
        listWorkflowRuns: ({ workflow_id, head_sha, event }) => {
          calls.runLookups.push({ workflow_id, head_sha, ...(event ? { event } : {}) })
          if (workflow_id === CI_WORKFLOW) {
            if (fake.ciError) return Promise.reject(Object.assign(new Error('API'), fake.ciError))
            return Promise.resolve({
              data: fake.ciRuns ?? {
                workflow_runs: [{ id: 70, run_attempt: 1, run_number: 7, status: 'completed' }],
              },
            })
          }
          // A fixed list: it does not show runs dispatched during the test, like
          // the API in the seconds after a dispatch.
          return Promise.resolve({ data: fake.runs ?? { total_count: 0, workflow_runs: [] } })
        },
        listJobsForWorkflowRun: ({ run_id, filter }) => {
          assert.equal(filter, 'latest', "a re-run's latest attempt decides")
          calls.jobLookups.push(run_id)
          return Promise.resolve({ data: fake.jobs?.[run_id] ?? { jobs: [] } })
        },
        createWorkflowDispatch: ({ workflow_id, ref, inputs }) => {
          calls.dispatches.push({ workflow_id, ref, inputs })
          return Promise.resolve({})
        },
      },
    },
  }
  return {
    ctx: { github, owner: 'copse-dev', repo: 'agent-pane', log: (m) => logs.push(m) },
    calls,
    logs,
    statuses,
  }
}

function ciRun(
  run_number: number,
  status: string,
  id = run_number * 10,
  run_attempt = 1,
): { id: number; run_attempt: number; run_number: number; status: string } {
  return { id, run_attempt, run_number, status }
}

describe('releaseTagAt', () => {
  it('returns the package version tag cut at exactly this commit', async () => {
    const { ctx, calls } = context({})
    assert.equal(await releaseTagAt(ctx, SHA), 'v1.2.3-beta.4')
    assert.deepEqual(calls.refs, ['tags/v1.2.3-beta.4'])
  })

  it('follows an annotated tag to its commit', async () => {
    const annotated = {
      ref: { object: { type: 'tag', sha: TAG_OBJECT } },
      tagObject: { object: { type: 'commit', sha: SHA } },
    }
    const { ctx, calls } = context(annotated)
    assert.equal(await releaseTagAt(ctx, SHA), 'v1.2.3-beta.4')
    assert.deepEqual(calls.tags, [TAG_OBJECT])
    const elsewhere = context({
      ...annotated,
      tagObject: { object: { type: 'commit', sha: OTHER } },
    })
    assert.equal(await releaseTagAt(elsewhere.ctx, SHA), null)
  })

  it('releases nothing when the version is untagged or tagged at another commit', async () => {
    // The ordinary promotion: its version was released by an earlier commit.
    const elsewhere = context({ ref: { object: { type: 'commit', sha: OTHER } } })
    assert.equal(await releaseTagAt(elsewhere.ctx, SHA), null)
    assert.match(elsewhere.logs.join('\n'), new RegExp(`tagged at ${OTHER}`))
    const untagged = context({ refError: { status: 404 } })
    assert.equal(await releaseTagAt(untagged.ctx, SHA), null)
    assert.match(untagged.logs.join('\n'), /is not tagged/)
  })

  it('fails on lookup errors instead of reading them as "nothing to release"', async () => {
    // A rate limit read as an untagged version would silently skip a release.
    await assert.rejects(releaseTagAt(context({ refError: { status: 500 } }).ctx, SHA), /API/)
    await assert.rejects(
      releaseTagAt(context({ ref: { object: { type: 'commit' } } }).ctx, SHA),
      /no target/,
    )
  })

  it('never builds a tag ref from an unusable version or SHA', async () => {
    for (const fake of [
      { version: '1.2' },
      { version: '1.2.3/../../heads/main' },
      { version: 7 },
      { packageJson: '{not json' },
      { packageJson: null },
    ]) {
      const { ctx, calls } = context(fake)
      await assert.rejects(releaseTagAt(ctx, SHA))
      assert.deepEqual(calls.refs, [], JSON.stringify(fake))
    }
    await assert.rejects(releaseTagAt(context({}).ctx, 'main'), /Invalid release commit SHA/)
  })
})

/** Jobs of a Release (macOS) run whose preflight got as far as `pendingStep`. */
function preflight(pendingStep: { status: string; conclusion: string | null }): unknown {
  return {
    jobs: [
      {
        name: RELEASE_PREFLIGHT_JOB,
        steps: [
          {
            name: 'Validate tag, version, ancestry, and exact-SHA CI',
            status: 'completed',
            conclusion: 'success',
          },
          { name: CI_PENDING_STEP, ...pendingStep },
          {
            name: 'Preserve the validation used for packaging',
            status: 'completed',
            conclusion: 'skipped',
          },
        ],
      },
    ],
  }
}
const STOPPED_PENDING = preflight({ status: 'completed', conclusion: 'failure' })
const DECIDED = preflight({ status: 'completed', conclusion: 'skipped' })

describe('startReleaseBuild', () => {
  it('dispatches Release (macOS) at the tag and records the CI result it acted on', async () => {
    const { ctx, calls, statuses } = context({})
    assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3', CI), 'started')
    assert.deepEqual(calls.runLookups, [{ workflow_id: 'release-mac.yml', head_sha: SHA }])
    assert.deepEqual(calls.dispatches, [
      { workflow_id: RELEASE_WORKFLOW, ref: 'v1.2.3', inputs: { tag: 'v1.2.3' } },
    ])
    assert.deepEqual(statuses, [
      {
        context: RELEASE_DISPATCH_CONTEXT,
        state: 'success',
        description: 'Dispatched Release (macOS) for v1.2.3',
        target_url: CI_KEY,
        creator: ACTIONS_BOT,
      },
    ])
  })

  it('never dispatches a second run for a commit, even after a failed one', async () => {
    // A failed release is reported and fixed forward, not retried.
    for (const jobs of [DECIDED, { jobs: [{ name: 'build-test', steps: [] }] }]) {
      const { ctx, calls } = context({ runs: { workflow_runs: [{ id: 11 }] }, jobs: { 11: jobs } })
      assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3', CI), 'already-started')
      assert.deepEqual(calls.dispatches, [])
    }
  })

  it('counts a run that has not reached its evidence read yet', async () => {
    // Its one read is still to come, so it will see whatever CI state exists
    // then; dispatching too would build the commit twice.
    for (const jobs of [
      { jobs: [] },
      { jobs: [{ name: RELEASE_PREFLIGHT_JOB, steps: [] }] },
      preflight({ status: 'queued', conclusion: null }),
    ]) {
      const { ctx, calls } = context({ runs: { workflow_runs: [{ id: 11 }] }, jobs: { 11: jobs } })
      assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3', CI), 'already-started')
      assert.deepEqual(calls.dispatches, [])
    }
  })

  it('does not count a run that stopped because CI had not finished', async () => {
    for (const jobs of [STOPPED_PENDING, preflight({ status: 'in_progress', conclusion: null })]) {
      const { ctx, calls, logs } = context({
        runs: { workflow_runs: [{ id: 11 }] },
        jobs: { 11: jobs },
      })
      assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3', CI), 'started')
      assert.deepEqual(calls.jobLookups, [11])
      assert.equal(calls.dispatches.length, 1)
      assert.match(logs.join('\n'), /run 11 stopped before CI finished; it does not count/)
    }
  })

  it('still counts a decided run beside early stopped ones', async () => {
    const { ctx, calls } = context({
      runs: { workflow_runs: [{ id: 11 }, { id: 12 }] },
      jobs: { 11: STOPPED_PENDING, 12: DECIDED },
    })
    assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3', CI), 'already-started')
    assert.deepEqual(calls.jobLookups, [11, 12])
    assert.deepEqual(calls.dispatches, [])
  })

  it('trusts only its own record, and only for the same CI result', async () => {
    const record = {
      context: RELEASE_DISPATCH_CONTEXT,
      state: 'success',
      target_url: CI_KEY,
      creator: ACTIONS_BOT,
    }
    const own = context({ statuses: [record] })
    assert.equal(await startReleaseBuild(own.ctx, SHA, 'v1.2.3', CI), 'already-started')
    assert.deepEqual(own.calls.dispatches, [])
    for (const other of [
      { ...record, creator: { id: 1, login: 'someone' } },
      { ...record, context: 'CI Passed' },
      { ...record, state: 'pending' },
      { ...record, target_url: CI_KEY.replace('attempts/1', 'attempts/2') },
    ]) {
      const { ctx, calls } = context({ statuses: [other] })
      assert.equal(
        await startReleaseBuild(ctx, SHA, 'v1.2.3', CI),
        'started',
        JSON.stringify(other),
      )
      assert.equal(calls.dispatches.length, 1)
    }
  })

  it('fails closed when runs, jobs or statuses cannot be read, and on a failed record', async () => {
    for (const fake of [
      { runs: { total_count: 0 } },
      { runs: { workflow_runs: [{ status: 'completed' }] } },
      { runs: { workflow_runs: [{ id: 11 }] }, jobs: { 11: {} } },
    ]) {
      const { ctx, calls } = context(fake)
      await assert.rejects(startReleaseBuild(ctx, SHA, 'v1.2.3', CI), /Release \(macOS\) run/)
      assert.deepEqual(calls.dispatches, [], JSON.stringify(fake))
    }
    await assert.rejects(startReleaseBuild(context({}).ctx, 'v1.2.3', 'v1.2.3', CI))
    // The dispatch happened, so the job fails and reports; a re-run then finds
    // the dispatched run in the run list.
    const unrecorded = context({ statusWriteError: true })
    await assert.rejects(startReleaseBuild(unrecorded.ctx, SHA, 'v1.2.3', CI), /status API/)
    assert.equal(unrecorded.calls.dispatches.length, 1)
  })
})

describe('the tag cut and CI completion overlapping', () => {
  it('dispatches once when both evaluations see the run list from before the dispatch', async () => {
    // release-cut.yml hands the commit to release-dispatch.yml just as CI
    // completes. The workflow's concurrency group runs the two evaluations one
    // after the other; the second reads a run list that does not show the first
    // one's dispatch yet. The shared record is what stops a second dispatch.
    const statuses: Status[] = []
    const handOver = context({ statuses })
    const ciCompletion = context({ statuses })
    assert.equal(await startReleaseWhenCiFinished(handOver.ctx, SHA, 'v1.2.3'), 'started')
    assert.equal(
      await startReleaseWhenCiFinished(ciCompletion.ctx, SHA, 'v1.2.3'),
      'already-started',
    )
    assert.equal(handOver.calls.dispatches.length + ciCompletion.calls.dispatches.length, 1)
    assert.deepEqual(
      ciCompletion.calls.runLookups.map((lookup) => lookup.workflow_id),
      ['ci.yml'],
    )
  })

  it('evaluates a CI re-run afresh, so a build its re-run stopped still starts', async () => {
    // The dispatched run read CI while a re-run was in progress and stopped.
    // The re-run's completion is a new CI result, so the record does not apply.
    const statuses: Status[] = []
    const first = context({ statuses })
    assert.equal(await startReleaseWhenCiFinished(first.ctx, SHA, 'v1.2.3'), 'started')
    const afterReRun = context({
      statuses,
      ciRuns: { workflow_runs: [ciRun(7, 'completed', 70, 2)] },
      runs: { workflow_runs: [{ id: 11 }] },
      jobs: { 11: STOPPED_PENDING },
    })
    assert.equal(await startReleaseWhenCiFinished(afterReRun.ctx, SHA, 'v1.2.3'), 'started')
    assert.equal(afterReRun.calls.dispatches.length, 1)
    assert.deepEqual(
      statuses.map((status) => status.target_url),
      [CI_KEY, CI_KEY.replace('attempts/1', 'attempts/2')],
    )
  })
})

describe('a manual dispatch before CI finishes, then CI completion', () => {
  it('still starts the automatic build once CI has finished', async () => {
    // The person's run stopped at preflight while CI was pending. When CI then
    // completes, release-dispatch.yml must not mistake it for the release.
    const runs = { workflow_runs: [{ id: 21 }] }
    const pending = context({
      runs,
      jobs: { 21: STOPPED_PENDING },
      ciRuns: { workflow_runs: [ciRun(30, 'in_progress')] },
    })
    assert.equal(await startReleaseWhenCiFinished(pending.ctx, SHA, 'v1.2.3'), 'ci-running')
    assert.deepEqual(pending.calls.dispatches, [])

    const completed = context({
      runs,
      jobs: { 21: STOPPED_PENDING },
      ciRuns: { workflow_runs: [ciRun(30, 'completed')] },
    })
    assert.equal(await startReleaseWhenCiFinished(completed.ctx, SHA, 'v1.2.3'), 'started')
    assert.deepEqual(completed.calls.dispatches, [
      { workflow_id: RELEASE_WORKFLOW, ref: 'v1.2.3', inputs: { tag: 'v1.2.3' } },
    ])
  })
})

describe('newestCiRun and ciFinished', () => {
  it('reads the newest CI push run at the commit, whatever its conclusion', async () => {
    const { ctx, calls } = context({
      ciRuns: {
        workflow_runs: [
          ciRun(3, 'in_progress'),
          { ...ciRun(9, 'completed', 90, 2), conclusion: 'failure' },
        ],
      },
    })
    assert.deepEqual(await newestCiRun(ctx, SHA), { id: 90, attempt: 2, status: 'completed' })
    assert.equal(await ciFinished(ctx, SHA), true)
    assert.deepEqual(calls.runLookups[0], { workflow_id: 'ci.yml', head_sha: SHA, event: 'push' })
  })

  it('treats a newer run or re-run still in progress, or no run yet, as not finished', async () => {
    for (const ciRuns of [
      { workflow_runs: [ciRun(9, 'completed'), ciRun(12, 'in_progress')] },
      { workflow_runs: [ciRun(9, 'queued')] },
      { workflow_runs: [] },
    ]) {
      assert.equal(await ciFinished(context({ ciRuns }).ctx, SHA), false, JSON.stringify(ciRuns))
    }
    assert.equal(await newestCiRun(context({ ciRuns: { workflow_runs: [] } }).ctx, SHA), null)
  })

  it('throws on an API error or unreadable runs instead of answering either way', async () => {
    // Reading an error as "finished" would dispatch before CI ends and spend the
    // commit's one automatic run on a preflight that can only fail.
    await assert.rejects(ciFinished(context({ ciError: { status: 502 } }).ctx, SHA), /API/)
    await assert.rejects(ciFinished(context({ ciRuns: {} }).ctx, SHA), /CI runs/)
    for (const run of [
      { status: 'completed' },
      { run_number: 7, status: 'completed' },
      { id: 70, run_number: 7, status: 'completed' },
    ]) {
      await assert.rejects(
        ciFinished(context({ ciRuns: { workflow_runs: [run] } }).ctx, SHA),
        /run number, id or attempt/,
      )
    }
  })
})

describe('startReleaseWhenCiFinished', () => {
  it('leaves the build to CI completion while CI is still running', async () => {
    const { ctx, calls, logs } = context({
      ciRuns: { workflow_runs: [ciRun(4, 'in_progress')] },
    })
    assert.equal(await startReleaseWhenCiFinished(ctx, SHA, 'v1.2.3'), 'ci-running')
    assert.deepEqual(calls.dispatches, [])
    assert.match(logs.join('\n'), /still running; its completion starts Release \(macOS\)/)
  })

  it('starts the build once CI has finished', async () => {
    const { ctx, calls } = context({})
    assert.equal(await startReleaseWhenCiFinished(ctx, SHA, 'v1.2.3'), 'started')
    assert.equal(calls.dispatches.length, 1)
  })

  it('does not dispatch when the CI read fails', async () => {
    const { ctx, calls } = context({ ciError: { status: 500 } })
    await assert.rejects(startReleaseWhenCiFinished(ctx, SHA, 'v1.2.3'))
    assert.deepEqual(calls.dispatches, [])
  })
})
