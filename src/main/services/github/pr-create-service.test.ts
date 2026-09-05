import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPrForThread, type PrCreateDependencies } from './pr-create-service.ts'
import type { PrCreateInput } from './backend/backend.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'

// The one create path, shared by the `gh_pr_create` tool and the "Create PR"
// dialog. What matters here is that both get the same four things: the right
// checkout's branches, the attribution trailer, the draft flag as asked, and
// the `threads:pr_created` announce the Changes panel follows.

const WORKTREE_CONTEXT: ThreadExecutionContext = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectRoot: '/repo',
  root: '/repo/.worktrees/thread-1',
  checkoutMode: 'worktree',
  branch: 'feature/x',
}

interface Broadcast {
  channel: string
  args: unknown[]
}

interface Recorded {
  deps: PrCreateDependencies
  created: PrCreateInput[]
  slugRoots: (string | null | undefined)[]
  branchRoots: (string | null | undefined)[]
  broadcasts: Broadcast[]
}

function deps(over: Partial<PrCreateDependencies> = {}): Recorded {
  const created: PrCreateInput[] = []
  const slugRoots: (string | null | undefined)[] = []
  const branchRoots: (string | null | undefined)[] = []
  const broadcasts: Broadcast[] = []
  const base: PrCreateDependencies = {
    getGithubRepoSlug: (root) => {
      slugRoots.push(root)
      return Promise.resolve('copse-dev/agent-pane')
    },
    getCurrentBranchName: (root) => {
      branchRoots.push(root)
      return Promise.resolve('feature/x')
    },
    getDefaultBranch: () => Promise.resolve('main'),
    createPullRequest: (input) => {
      created.push(input)
      return Promise.resolve({
        ok: true,
        backend: 'cli' as const,
        url: 'https://github.com/copse-dev/agent-pane/pull/7',
        number: 7,
        message: 'Opened PR #7',
      })
    },
    getThreadModels: () => ['claude-opus-5'],
    backendKind: () => 'cli',
    broadcast: (channel, ...args) => {
      broadcasts.push({ channel, args })
    },
    ...over,
  }
  return { deps: base, created, slugRoots, branchRoots, broadcasts }
}

/** The `threads:pr_created` pushes a run made, in order. */
function announcements(recorded: Recorded): unknown[][] {
  return recorded.broadcasts.filter((b) => b.channel === 'threads:pr_created').map((b) => b.args)
}

describe('createPrForThread', () => {
  it("reads branches from the thread's own checkout, not the ambient root", async () => {
    // The whole point of threading context through: a worktree thread that
    // resolved the shared tree's branch would open the PR from the wrong place.
    const recorded = deps()
    await createPrForThread({ title: 'Roll up tool activity' }, WORKTREE_CONTEXT, recorded.deps)

    assert.deepEqual(recorded.slugRoots, ['/repo/.worktrees/thread-1'])
    assert.deepEqual(recorded.branchRoots, ['/repo/.worktrees/thread-1'])
    const created = recorded.created[0]
    assert.ok(created, 'the PR should have been created')
    assert.equal(created.head, 'feature/x')
    assert.equal(created.base, 'main')
  })

  it('appends the attribution trailer to the body it was handed', async () => {
    const recorded = deps()
    await createPrForThread(
      { title: 'Roll up tool activity', body: 'Groups a run under its anchor.' },
      WORKTREE_CONTEXT,
      recorded.deps,
    )

    const body = recorded.created[0]?.body ?? ''
    assert.match(body, /Groups a run under its anchor\./)
    assert.match(body, /Co-Authored-By/i)
  })

  it('still attributes a PR opened with an empty description', async () => {
    // The dialog's Description field is optional, so this is the ordinary path
    // when a model is not configured — the trailer must not go missing with it.
    const recorded = deps()
    await createPrForThread({ title: 'Roll up tool activity' }, WORKTREE_CONTEXT, recorded.deps)
    assert.match(recorded.created[0]?.body ?? '', /Co-Authored-By/i)
  })

  it('passes the draft flag through, and omits it when unset', async () => {
    const drafted = deps()
    await createPrForThread({ title: 'T', draft: true }, WORKTREE_CONTEXT, drafted.deps)
    assert.equal(drafted.created[0]?.draft, true)

    const plain = deps()
    await createPrForThread({ title: 'T' }, WORKTREE_CONTEXT, plain.deps)
    assert.equal(plain.created[0]?.draft, undefined)
  })

  it('refuses to open a PR from the default branch onto itself', async () => {
    const recorded = deps({ getCurrentBranchName: () => Promise.resolve('main') })
    const result = await createPrForThread({ title: 'T' }, WORKTREE_CONTEXT, recorded.deps)

    assert.equal(result.ok, false)
    assert.match(result.message, /head and base are both main/)
    assert.equal(recorded.created.length, 0)
  })

  it('rejects half a target rather than splicing in the workspace slug', async () => {
    const recorded = deps()
    const result = await createPrForThread(
      { title: 'T', owner: 'someone' },
      WORKTREE_CONTEXT,
      recorded.deps,
    )

    assert.equal(result.ok, false)
    assert.match(result.message, /pass owner and repo together/)
    assert.equal(recorded.created.length, 0)
  })

  it('requires explicit branches for a repo the checkout cannot describe', async () => {
    const recorded = deps()
    const result = await createPrForThread(
      { title: 'T', owner: 'other', repo: 'elsewhere' },
      WORKTREE_CONTEXT,
      recorded.deps,
    )

    assert.equal(result.ok, false)
    assert.match(result.message, /pass head and base explicitly/)
    assert.equal(recorded.created.length, 0)
  })

  it('names the serving backend on a pre-flight rejection', async () => {
    // PrCreateResult is one shape for all consumers and `backend` is required;
    // a rejection that never reached a backend still must not invent a kind.
    const recorded = deps({ backendKind: () => 'api' })
    const result = await createPrForThread(
      { title: 'T', owner: 'someone' },
      WORKTREE_CONTEXT,
      recorded.deps,
    )
    assert.equal(result.backend, 'api')
  })

  it('announces the created PR so a Changes panel can follow it', async () => {
    // #2297 taught the Changes panel to follow a PR the agent opened; the
    // announce lives here rather than in the tool so the composer's dialog —
    // the other door onto this function — moves the panel the same way.
    const recorded = deps()
    const result = await createPrForThread({ title: 'T' }, WORKTREE_CONTEXT, recorded.deps)

    assert.equal(result.ok, true)
    assert.deepEqual(announcements(recorded), [
      [
        'project-1',
        'thread-1',
        {
          url: 'https://github.com/copse-dev/agent-pane/pull/7',
          owner: 'copse-dev',
          repo: 'agent-pane',
          number: 7,
        },
      ],
    ])
  })

  it('announces nothing when the PR did not open', async () => {
    // A panel that jumped to a PR view on a failed create would be showing
    // coordinates no PR ever had.
    const recorded = deps({
      createPullRequest: () =>
        Promise.resolve({ ok: false, backend: 'cli' as const, message: 'gh: not authenticated' }),
    })
    const result = await createPrForThread({ title: 'T' }, WORKTREE_CONTEXT, recorded.deps)

    assert.equal(result.ok, false)
    assert.deepEqual(announcements(recorded), [])
  })

  it('announces nothing when a pre-flight check rejected the request', async () => {
    const recorded = deps({ getCurrentBranchName: () => Promise.resolve('main') })
    await createPrForThread({ title: 'T' }, WORKTREE_CONTEXT, recorded.deps)
    assert.deepEqual(announcements(recorded), [])
  })

  it('creates without a thread context, skipping the link', async () => {
    // A tool call outside any thread: the PR still opens, and nothing tries to
    // record it against a thread that does not exist.
    const recorded = deps()
    const result = await createPrForThread({ title: 'T' }, null, recorded.deps)

    assert.equal(result.ok, true)
    assert.equal(recorded.created.length, 1)
    assert.deepEqual(recorded.created[0]?.body.includes('Co-Authored-By'), true)
    // Nothing to announce it against: the announce is addressed to a thread.
    assert.deepEqual(recorded.broadcasts, [])
  })
})
