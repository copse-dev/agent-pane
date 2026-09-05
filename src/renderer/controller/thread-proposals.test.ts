import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { threadProposalStatus, type ThreadProposal } from '@shared/threads/thread-proposal.ts'
import { startProposedThread, type ThreadProposalControllerApi } from './thread-proposals.ts'

const proposal: ThreadProposal = {
  id: 'call-1',
  title: 'Migrate the settings store to Zod',
  summary: 'Replace the hand-rolled settings parsing with a Zod schema.',
  prompt: 'Replace the hand-rolled parsing in settings.ts with a Zod schema, then run the tests.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface Harness {
  api: ThreadProposalControllerApi
  prepared: Array<{ threadId: string; prompt: string; choice: string }>
  runs: Array<{ threadId: string; payload: string }>
}

/** What the repository grants when it cannot give the thread its own checkout. */
const SHARED_CHECKOUT: PreparedThreadCheckout = {
  checkoutMode: 'shared',
  choice: 'worktree',
  branch: 'main',
}

function harness(options: { prepareFails?: Error; grants?: PreparedThreadCheckout } = {}): Harness {
  const prepared: Harness['prepared'] = []
  const runs: Harness['runs'] = []
  const checkout: PreparedThreadCheckout = options.grants ?? {
    checkoutMode: 'worktree',
    choice: 'worktree',
    branch: 'copse/migrate-settings',
    worktree: {
      path: '/repo/.worktrees/copse-migrate-settings',
      branch: 'copse/migrate-settings',
      baseBranch: 'main',
      baseCommit: 'abc1234',
      createdAt: 1,
      seededFromDirtyProject: false,
    },
  }
  return {
    prepared,
    runs,
    api: {
      agent: {
        prepareCheckout(_projectId, threadId, prompt, choice): Promise<PreparedThreadCheckout> {
          prepared.push({ threadId, prompt, choice })
          if (options.prepareFails) return Promise.reject(options.prepareFails)
          return Promise.resolve(checkout)
        },
        run(_projectId, threadId, payload): Promise<void> {
          runs.push({ threadId, payload })
          return Promise.resolve()
        },
      },
    },
  }
}

function storeWithSource(): ReturnType<typeof createStore> {
  return createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    activeThreadId: 'source',
    threads: [
      {
        id: 'source',
        title: 'Original work',
        status: 'idle',
        // A realistic offering thread: a proposal can only exist inside an
        // assistant turn, so the source is never a blank thread.
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'Add a null check to the JSON parser.',
            toolCalls: [],
            createdAt: 1,
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Done. While I was in there I noticed the settings parsing.',
            toolCalls: [
              {
                id: 'call-1',
                name: 'propose_thread',
                args: { title: proposal.title, summary: proposal.summary, prompt: proposal.prompt },
                status: 'done',
                result: 'Offered to the user.',
              },
            ],
            createdAt: 2,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
}

test('accepting a proposal starts an isolated thread seeded with the prompt', async () => {
  const store = storeWithSource()
  const h = harness()

  const { threadId, checkoutMode } = await startProposedThread(store, h.api, 'source', proposal)

  assert.equal(checkoutMode, 'worktree')
  const created = getThreadById(store, threadId)
  assert.ok(created)
  assert.equal(created.title, proposal.title)
  assert.deepEqual(created.proposedBy, { threadId: 'source', proposalId: 'call-1' })
  // The card promised an isolated checkout, so the request must ask for one.
  assert.deepEqual(h.prepared, [{ threadId, prompt: proposal.prompt, choice: 'worktree' }])
  assert.equal(created.worktreeChoice, 'worktree')
  assert.equal(created.gitBranch, 'copse/migrate-settings')
  // The prompt is in the transcript, not just in the run payload.
  assert.deepEqual(
    created.messages.map((m) => [m.role, m.content]),
    [['user', proposal.prompt]],
  )
  assert.equal(created.status, 'running')

  assert.equal(h.runs.length, 1)
  const run = h.runs[0]
  assert.ok(run)
  assert.equal(run.threadId, threadId)
  const payload: unknown = JSON.parse(run.payload)
  assert.ok(isRecord(payload))
  assert.equal(payload['content'], proposal.prompt)
  // A human click is its own root turn, with a fresh continuation budget.
  assert.equal(typeof payload['turnTreeId'], 'string')
})

test('the offering thread records the answer and the thread it created', async () => {
  const store = storeWithSource()
  const h = harness()

  const { threadId } = await startProposedThread(store, h.api, 'source', proposal)

  const source = getThreadById(store, 'source')
  assert.ok(source)
  assert.equal(threadProposalStatus(source.threadProposals, 'call-1'), 'started')
  assert.equal(source.threadProposals?.[0]?.threadId, threadId)
  // `assert.equal` from node:assert/strict narrows, so the row is defined here.
  assert.equal(source.threadProposals[0].checkoutMode, 'worktree')
})

test('the new thread becomes the active one', async () => {
  const store = storeWithSource()
  const { threadId } = await startProposedThread(store, harness().api, 'source', proposal)
  assert.equal(store.getState().activeThreadId, threadId)
})

// The card offers work "in its own checkout", but `decideThreadWorktreePolicy`
// degrades to a shared checkout for a non-git folder, a remote project, a
// detached HEAD, or a project with worktrees off. The run still goes ahead —
// refusing would make the feature unusable exactly where the composer works
// fine — but the broken promise must not pass unremarked.
test('a repository that cannot isolate still runs the work, and says so', async () => {
  const store = storeWithSource()
  const h = harness({ grants: SHARED_CHECKOUT })

  const started = await startProposedThread(store, h.api, 'source', proposal)

  // Isolation was still what was asked for; only the grant differs.
  assert.deepEqual(h.prepared, [
    { threadId: started.threadId, prompt: proposal.prompt, choice: 'worktree' },
  ])
  // Reported back to the caller, which is what drives the notice to the user.
  assert.equal(started.checkoutMode, 'shared')

  // The work is not refused: the prompt is in the transcript and dispatched.
  const created = getThreadById(store, started.threadId)
  assert.deepEqual(
    created?.messages.map((m) => m.content),
    [proposal.prompt],
  )
  assert.equal(created.status, 'running')
  assert.equal(h.runs.length, 1)

  // And the record is honest, so the settled card stops claiming isolation.
  const decision = getThreadById(store, 'source')?.threadProposals?.[0]
  assert.equal(decision?.status, 'started')
  assert.equal(decision.checkoutMode, 'shared')
})

test('a failed checkout leaves the offer standing and dispatches nothing', async () => {
  const store = storeWithSource()
  const h = harness({ prepareFails: new Error('worktree allocation failed') })

  await assert.rejects(
    () => startProposedThread(store, h.api, 'source', proposal),
    /worktree allocation failed/,
  )

  assert.deepEqual(h.runs, [])
  const source = getThreadById(store, 'source')
  assert.equal(threadProposalStatus(source?.threadProposals, 'call-1'), 'pending')
  // Nothing was said in the new thread's name, so it holds no prompt to resend.
  const created = store.getState().threads.find((t) => t.id !== 'source')
  assert.deepEqual(created?.messages ?? [], [])
  assert.notEqual(created?.status, 'running')
})

test('a proposal cannot be started without an open project', async () => {
  const store = createStore({ activeProjectId: null, threads: [] })
  await assert.rejects(
    () => startProposedThread(store, harness().api, 'source', proposal),
    /Open a project/,
  )
})
