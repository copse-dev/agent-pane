import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Message, ToolCall } from '@shared/types'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Component-tier coverage of the model-proposed-thread card. The pure model is
// unit-tested in `@copse/thread-store/thread-proposal.test.ts` and the start
// path in `controller/thread-proposals.test.ts`; this pins what the user sees
// and clicks — that the offer is a card rather than a prompt, that the
// description leads and the raw prompt is folded away, and that answering it
// settles the card in place.

const PROPOSAL_ARGS = {
  title: 'Migrate the settings store to Zod',
  summary:
    'Replace the hand-rolled settings parsing with a Zod schema so a malformed config fails loudly instead of silently reading as defaults.',
  rationale: 'It touches every settings call site, so it should not ride along with this fix.',
  prompt:
    'Replace the hand-rolled parsing in src/main/services/storage/settings.ts with a Zod schema.',
  files: ['src/main/services/storage/settings.ts', 'src/shared/types/state.ts'],
}

const runs: Array<{ threadId: string }> = []

function fakeApi(): ApiClient {
  const base = createFakeApi()
  const checkout: PreparedThreadCheckout = {
    checkoutMode: 'worktree',
    choice: 'worktree',
    branch: 'copse/migrate-settings',
  }
  return {
    ...base,
    agent: {
      ...base['agent'],
      prepareCheckout: () => Promise.resolve(checkout),
      run: (_projectId: string, threadId: string): Promise<void> => {
        runs.push({ threadId })
        return Promise.resolve()
      },
      abort: () => Promise.resolve(),
    },
  } satisfies ApiClient
}

function proposalCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'propose_thread',
    args: PROPOSAL_ARGS,
    status: 'done',
    result: 'Offered to the user.',
    ...overrides,
  }
}

function transcript(toolCalls: ToolCall[]): Message[] {
  return [
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
      content: 'Done — and I spotted something worth its own thread.',
      toolCalls,
      createdAt: 2,
    },
  ]
}

function mount(toolCalls: ToolCall[] = [proposalCall()]): {
  store: AppStore
  root: HTMLElement
  threadId: string
  unmount: () => void
} {
  const store = createStore({ activeProjectId: 'project-a', workspaceRoot: '/repo', threads: [] })
  const threadId = createThread(store)
  store.setState({
    threads: store
      .getState()
      .threads.map((t) => (t.id !== threadId ? t : { ...t, messages: transcript(toolCalls) })),
  })
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = mountConversation(root, store, fakeApi())
  store.emit('threads_changed')
  return { store, root, threadId, unmount }
}

function card(root: HTMLElement): HTMLDetailsElement {
  const found = root.querySelector<HTMLDetailsElement>('.thread-proposal')
  assert.ok(found, 'the proposal renders its own card')
  return found
}

afterEach(() => {
  document.body.replaceChildren()
  runs.length = 0
})

describe('model-proposed thread card', () => {
  it('renders the offer as a top-level card, not a tool disclosure', () => {
    const { root, unmount } = mount()
    const proposal = card(root)
    assert.equal(proposal.dataset['proposalStatus'], 'pending')
    // Open by default: a standing offer the user has not answered.
    assert.equal(proposal.open, true)
    assert.equal(proposal.querySelector('.thread-proposal-eyebrow')?.textContent, 'Proposed thread')
    // Not a permission prompt: nothing modal, nothing approve/reject.
    assert.equal(document.querySelector('.approval-dialog'), null)
    assert.equal(root.querySelector('.thread-proposal .approval-heading'), null)
    unmount()
  })

  it('leads with the human-readable description and folds the prompt away', () => {
    const { root, unmount } = mount()
    const proposal = card(root)
    assert.equal(proposal.querySelector('.thread-proposal-title')?.textContent, PROPOSAL_ARGS.title)
    assert.equal(
      proposal.querySelector('.thread-proposal-summary')?.textContent,
      PROPOSAL_ARGS.summary,
    )
    assert.equal(
      proposal.querySelector('.thread-proposal-rationale')?.textContent,
      PROPOSAL_ARGS.rationale,
    )
    // The description is a heading tier below the serif display tier.
    assert.ok(proposal.querySelector('h4.thread-proposal-title'))

    const prompt = proposal.querySelector<HTMLDetailsElement>('.thread-proposal-prompt')
    assert.ok(prompt)
    assert.equal(prompt.open, false, 'the raw prompt starts folded')
    assert.equal(
      prompt.querySelector('.thread-proposal-prompt-text')?.textContent,
      PROPOSAL_ARGS.prompt,
    )
    unmount()
  })

  it('says the work would run in its own checkout, and what it would touch', () => {
    const { root, unmount } = mount()
    const chips = card(root).querySelectorAll('.thread-proposal-chip')
    const labels = Array.from(chips, (chip) => chip.textContent)
    assert.equal(labels.length, 2)
    assert.match(labels[0] ?? '', /own checkout/i)
    assert.match(labels[1] ?? '', /settings\.ts/)
    unmount()
  })

  it('stays out of the turn rollup even in a busy turn', () => {
    const busy: ToolCall[] = [
      { id: 'r1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: 'ok' },
      { id: 'r2', name: 'read_file', args: { path: 'b.ts' }, status: 'done', result: 'ok' },
      { id: 'r3', name: 'run_shell', args: { command: 'pnpm test' }, status: 'done', result: 'ok' },
      proposalCall(),
    ]
    const { root, unmount } = mount(busy)
    assert.ok(root.querySelector('.tool-card-rollup'), 'the ordinary tools still roll up')
    assert.equal(
      root.querySelector('.tool-card-rollup .thread-proposal'),
      null,
      'the offer is not buried inside the rollup',
    )
    assert.ok(card(root))
    unmount()
  })

  it('falls back to an ordinary tool card while the arguments are still streaming', () => {
    const { root, unmount } = mount([
      proposalCall({ args: { title: 'Migrate the sett' }, status: 'running', result: null }),
    ])
    assert.equal(root.querySelector('.thread-proposal'), null)
    assert.ok(root.querySelector('.tool-card[data-tool-id="call-1"]'))
    unmount()
  })

  it('dismissing settles the card in place and can be undone', () => {
    const { root, store, threadId, unmount } = mount()
    card(root).querySelector<HTMLButtonElement>('.thread-proposal-dismiss')?.click()

    const dismissed = card(root)
    assert.equal(dismissed.dataset['proposalStatus'], 'dismissed')
    assert.equal(dismissed.open, false, 'an answered offer collapses to one quiet line')
    assert.match(dismissed.querySelector('.thread-proposal-state')?.textContent ?? '', /Dismissed/)
    assert.equal(
      store.getState().threads.find((t) => t.id === threadId)?.threadProposals?.[0]?.status,
      'dismissed',
    )
    // Nothing was started.
    assert.deepEqual(runs, [])

    dismissed.querySelector<HTMLButtonElement>('.thread-proposal-restore')?.click()
    assert.equal(card(root).dataset['proposalStatus'], 'pending')
    assert.equal(
      store.getState().threads.find((t) => t.id === threadId)?.threadProposals,
      undefined,
      'undoing leaves no answer behind',
    )
    unmount()
  })

  it('starting the thread runs it and leaves a link back on the card', async () => {
    const { root, store, threadId, unmount } = mount()
    card(root).querySelector<HTMLButtonElement>('.thread-proposal-start')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const decision = store.getState().threads.find((t) => t.id === threadId)?.threadProposals?.[0]
    // `assert.equal` from node:assert/strict narrows, so `decision` is defined here.
    assert.equal(decision?.status, 'started')
    const startedId = decision.threadId
    assert.ok(startedId)
    assert.deepEqual(runs, [{ threadId: startedId }])

    // Back on the offering thread, the card records what it made.
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    const settled = card(root)
    assert.equal(settled.dataset['proposalStatus'], 'started')
    assert.match(settled.querySelector('.thread-proposal-state')?.textContent ?? '', /started/i)
    // Reachable from the collapsed header, not from behind the disclosure.
    assert.ok(
      settled.querySelector('.thread-proposal-header .thread-proposal-open'),
      'the created thread stays reachable without expanding the card',
    )

    settled.querySelector<HTMLButtonElement>('.thread-proposal-open')?.click()
    assert.equal(store.getState().activeThreadId, startedId)
    unmount()
  })

  it('says so when the repository could not give the thread its own checkout', () => {
    // The pending card offers "its own checkout"; when the policy degraded to
    // shared, the settled row is where that promise gets corrected.
    const { root, store, threadId, unmount } = mount()
    store.setState({
      threads: store.getState().threads.map((t) =>
        t.id !== threadId
          ? t
          : {
              ...t,
              threadProposals: [
                {
                  id: 'call-1',
                  status: 'started' as const,
                  decidedAt: 1,
                  threadId,
                  checkoutMode: 'shared' as const,
                },
              ],
            },
      ),
    })
    store.emit('threads_changed')

    const settled = card(root)
    assert.equal(settled.dataset['proposalStatus'], 'started')
    const state = settled.querySelector<HTMLElement>('.thread-proposal-state')
    assert.ok(state)
    assert.equal(state.dataset['checkout'], 'shared')
    assert.match(state.textContent, /shared checkout/i)
    unmount()
  })

  it('keeps the plain started row when isolation was granted', () => {
    const { root, store, threadId, unmount } = mount()
    store.setState({
      threads: store.getState().threads.map((t) =>
        t.id !== threadId
          ? t
          : {
              ...t,
              threadProposals: [
                {
                  id: 'call-1',
                  status: 'started' as const,
                  decidedAt: 1,
                  threadId,
                  checkoutMode: 'worktree' as const,
                },
              ],
            },
      ),
    })
    store.emit('threads_changed')

    const state = card(root).querySelector<HTMLElement>('.thread-proposal-state')
    assert.ok(state)
    assert.equal(state.dataset['checkout'], undefined)
    assert.doesNotMatch(state.textContent, /shared/i)
    unmount()
  })

  it('drops the link when the started thread has since been deleted', () => {
    const { root, store, threadId, unmount } = mount()
    store.setState({
      threads: store.getState().threads.map((t) =>
        t.id !== threadId
          ? t
          : {
              ...t,
              threadProposals: [
                { id: 'call-1', status: 'started' as const, decidedAt: 1, threadId: 'gone' },
              ],
            },
      ),
    })
    store.emit('threads_changed')

    const settled = card(root)
    assert.equal(settled.dataset['proposalStatus'], 'started')
    assert.equal(settled.querySelector('.thread-proposal-open'), null)
    unmount()
  })
})
