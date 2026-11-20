import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CI_WORKFLOW,
  RELEASE_WORKFLOW,
  ciFinished,
  releaseTagAt,
  startReleaseBuild,
  startReleaseWhenCiFinished,
  type ReleaseDispatchContext,
  type ReleaseDispatchGitHub,
} from './release-dispatch.mts'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)

interface Fake {
  version?: unknown
  packageJson?: string | null
  ref?: unknown
  refError?: { status: number }
  tagObject?: unknown
  runs?: unknown
  ciRuns?: unknown
  ciError?: { status: number }
}

interface Calls {
  refs: string[]
  tags: string[]
  dispatches: { workflow_id: string; ref: string; inputs: { tag: string } }[]
  runLookups: { workflow_id: string; head_sha: string; event?: string }[]
}

function context(fake: Fake): { ctx: ReleaseDispatchContext; calls: Calls; logs: string[] } {
  const calls: Calls = { refs: [], tags: [], dispatches: [], runLookups: [] }
  const logs: string[] = []
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
              data: fake.ciRuns ?? { workflow_runs: [{ run_number: 7, status: 'completed' }] },
            })
          }
          return Promise.resolve({ data: fake.runs ?? { total_count: 0, workflow_runs: [] } })
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
  }
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

describe('startReleaseBuild', () => {
  it('dispatches Release (macOS) at the tag when the commit has no run', async () => {
    const { ctx, calls } = context({})
    assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3'), 'started')
    assert.deepEqual(calls.runLookups, [{ workflow_id: 'release-mac.yml', head_sha: SHA }])
    assert.deepEqual(calls.dispatches, [
      { workflow_id: RELEASE_WORKFLOW, ref: 'v1.2.3', inputs: { tag: 'v1.2.3' } },
    ])
  })

  it('never dispatches a second run for a commit, even after a failed one', async () => {
    // Both release-cut.yml and release-dispatch.yml may reach this for one
    // commit. A failed release is reported and fixed forward, not retried.
    const { ctx, calls } = context({ runs: { total_count: 1 } })
    assert.equal(await startReleaseBuild(ctx, SHA, 'v1.2.3'), 'already-started')
    assert.deepEqual(calls.dispatches, [])
  })

  it('fails closed when existing runs cannot be read', async () => {
    const { ctx, calls } = context({ runs: { workflow_runs: [] } })
    await assert.rejects(startReleaseBuild(ctx, SHA, 'v1.2.3'), /existing Release \(macOS\) runs/)
    assert.deepEqual(calls.dispatches, [])
    await assert.rejects(startReleaseBuild(context({}).ctx, 'v1.2.3', 'v1.2.3'))
  })
})

describe('ciFinished', () => {
  it('reads the newest CI push run at the commit, whatever its conclusion', async () => {
    const { ctx, calls } = context({
      ciRuns: {
        workflow_runs: [
          { run_number: 3, status: 'in_progress' },
          { run_number: 9, status: 'completed', conclusion: 'failure' },
        ],
      },
    })
    assert.equal(await ciFinished(ctx, SHA), true)
    assert.deepEqual(calls.runLookups, [{ workflow_id: 'ci.yml', head_sha: SHA, event: 'push' }])
  })

  it('treats a newer run or re-run still in progress, or no run yet, as not finished', async () => {
    for (const ciRuns of [
      {
        workflow_runs: [
          { run_number: 9, status: 'completed' },
          { run_number: 12, status: 'in_progress' },
        ],
      },
      { workflow_runs: [{ run_number: 9, status: 'queued' }] },
      { workflow_runs: [] },
    ]) {
      assert.equal(await ciFinished(context({ ciRuns }).ctx, SHA), false, JSON.stringify(ciRuns))
    }
  })

  it('throws on an API error or unreadable runs instead of answering either way', async () => {
    // Reading an error as "finished" would dispatch before CI ends and spend the
    // commit's one automatic run on a preflight that can only fail.
    await assert.rejects(ciFinished(context({ ciError: { status: 502 } }).ctx, SHA), /API/)
    await assert.rejects(ciFinished(context({ ciRuns: {} }).ctx, SHA), /CI runs/)
    await assert.rejects(
      ciFinished(context({ ciRuns: { workflow_runs: [{ status: 'completed' }] } }).ctx, SHA),
      /run number/,
    )
  })
})

describe('startReleaseWhenCiFinished', () => {
  it('leaves the build to CI completion while CI is still running', async () => {
    const { ctx, calls, logs } = context({
      ciRuns: { workflow_runs: [{ run_number: 4, status: 'in_progress' }] },
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
