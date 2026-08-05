import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addHookCard, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { HookCard, Message } from '@shared/types'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Component-tier coverage of the decision-10 hook-card family: the pure model +
// spine mapping is unit-tested in shared/hooks/hook-card.test.ts and the fold
// attach in shared/threads/fold.test.ts; this pins the *rendering* — the
// right-aligned blue card family, the executions/decisions/halts, and the
// origin marker on a hook-originated turn — without Electron.

function fakeApi(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    } satisfies ApiClient
  })()
}

function seedThread(store: ReturnType<typeof createStore>, messages: Message[]): string {
  const threadId = createThread(store)
  const threads = store.getState().threads.map((t) => (t.id !== threadId ? t : { ...t, messages }))
  store.setState({ threads })
  store.emit('threads_changed')
  return threadId
}

function card(overrides: Partial<HookCard> = {}): HookCard {
  return {
    id: 'run-1',
    event: 'beforeShellExecution',
    hookId: 'guard.sh',
    executor: 'command',
    kind: 'execution',
    status: 'ok',
    durationMs: 12,
    parseOk: true,
    ...overrides,
  }
}

/**
 * Open an inspector and let its fetch settle. jsdom does not fire `toggle` for a
 * programmatic `open`, so the event is dispatched explicitly; the load itself is
 * a promise, hence the flush.
 */
async function openInspector(inspector: HTMLDetailsElement): Promise<void> {
  inspector.open = true
  inspector.dispatchEvent(new Event('toggle'))
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('hook cards (component, decision 10)', () => {
  it('renders folded hook cards as a right-aligned family after their message', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    seedThread(store, [
      {
        id: 'u1',
        role: 'user',
        content: 'run the build',
        toolCalls: [],
        createdAt: 1,
        hookCards: [
          card({ id: 'h-allow', event: 'beforeShellExecution', status: 'allow' }),
          card({ id: 'h-deny', event: 'beforeShellExecution', kind: 'decision', status: 'deny' }),
        ],
      },
    ])

    const hostEl = document.querySelector<HTMLElement>('[data-hook-cards-for="u1"]')
    assert.ok(hostEl, 'a hook-card host is rendered for the turn')
    // Rendered as the message's next sibling, not nested inside the user bubble.
    const anchor = hostEl.previousElementSibling
    assert.ok(anchor)
    assert.equal(anchor.getAttribute('data-message-id'), 'u1', 'hook cards sit after their anchor')
    const cards = hostEl.querySelectorAll('.hook-card')
    assert.equal(cards.length, 2, 'both executions/decisions render as cards')
    const [first, second] = cards
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.getAttribute('data-status'), 'allow')
    assert.equal(second.getAttribute('data-status'), 'deny')
    assert.equal(second.getAttribute('data-hook-kind'), 'decision')
    // The card is a distinct family — not a user message.
    assert.equal(document.querySelector('.hook-card.msg-user'), null)
  })

  it('keeps the group collapsed and pre-opens only inner hooks that took action', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    seedThread(store, [
      {
        id: 'u1',
        role: 'user',
        content: 'run the build',
        toolCalls: [],
        createdAt: 1,
        hookCards: [
          card({ id: 'h1', status: 'ok' }),
          card({ id: 'h2', status: 'allow' }),
          card({ id: 'h3', kind: 'decision', status: 'deny' }),
        ],
      },
    ])

    const hostEl = document.querySelector<HTMLElement>('[data-hook-cards-for="u1"]')
    assert.ok(hostEl)
    // A single collapsed group wraps every card — not three loose cards.
    const group = hostEl.querySelector<HTMLElement>('.hook-card-group')
    assert.ok(group, 'the cards fold into one group entry')
    assert.equal(group.getAttribute('data-hook-count'), '3')
    // Collapsed by default: <details> starts closed.
    assert.equal(group.hasAttribute('open'), false, 'the group is collapsed by default')
    // The outcome leads; the less-interesting run count stays secondary.
    const summary = group.querySelector('.hook-card-header .hook-card-status')
    assert.ok(summary)
    assert.match(summary.textContent, /^1 blocked/)
    assert.match(summary.textContent, /3 ran/)
    // Worst status wins, so a deny is visible while collapsed.
    assert.equal(group.getAttribute('data-status'), 'deny')
    // Every individual card still lives inside the group, in fire order. Plain
    // and allow-only responses stay contracted; the applied deny is ready open
    // when the user expands the still-collapsed outer group.
    const inner = group.querySelectorAll('.hook-card')
    assert.equal(inner.length, 3, 'all cards are nested in the group body')
    assert.equal(inner[0]?.hasAttribute('open'), false)
    assert.equal(inner[1]?.hasAttribute('open'), false)
    assert.equal(inner[2]?.hasAttribute('open'), true)
    const actionCard = inner[2]
    assert.ok(actionCard)
    assert.match(actionCard.querySelector('.hook-card-status')?.textContent ?? '', /Blocked action/)
    assert.match(actionCard.querySelector('.hook-card-detail')?.textContent ?? '', /gated action/)
  })

  it('opens a non-blocking hook that changed the turn and names every effect in its details', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    seedThread(store, [
      {
        id: 'u1',
        role: 'user',
        content: 'run safely',
        toolCalls: [],
        createdAt: 1,
        hookCards: [
          card({
            id: 'h-rewrite',
            updatedInput: true,
            injectContextChars: 24,
            queuedMessageChars: 12,
          }),
        ],
      },
    ])

    const group = document.querySelector<HTMLDetailsElement>('.hook-card-group')
    const action = group?.querySelector<HTMLDetailsElement>('.hook-card')
    assert.ok(group)
    assert.ok(action)
    assert.equal(group.open, false, 'the outer hook group always auto-collapses')
    assert.equal(action.open, true, 'an applied effect opens inside the group')
    assert.match(action.querySelector('.hook-card-status')?.textContent ?? '', /Rewrote input \+2/)
    const detail = action.querySelector('.hook-card-detail')?.textContent ?? ''
    assert.match(detail, /Rewrote the tool input/)
    assert.match(detail, /Injected 24 chars of context/)
    assert.match(detail, /Queued a 12-char follow-up/)
  })

  it('marks a hook-originated turn with an origin marker (not a plain user message)', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    seedThread(store, [
      {
        id: 'u-hook',
        role: 'user',
        content: 'finish the open todos',
        toolCalls: [],
        origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
        editedByUser: true,
        createdAt: 1,
      },
    ])

    const msgEl = document.querySelector<HTMLElement>('[data-message-id="u-hook"]')
    assert.ok(msgEl, 'the message renders')
    assert.ok(msgEl.classList.contains('msg-hook-origin'), 'the turn is flagged hook-originated')
    assert.equal(msgEl.dataset['hookId'], 'todo-closeout')
    const marker = msgEl.querySelector('.msg-hook-origin-marker')
    assert.ok(marker, 'an origin marker is shown')
    const text = marker.textContent
    assert.match(text, /todo-closeout/)
    assert.match(text, /Stop/)
    assert.match(text, /edited/, 'editedByUser is surfaced')
  })

  it('renders a halt card with its stop reason detail', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    seedThread(store, [
      {
        id: 'a1',
        role: 'assistant',
        content: 'stopping',
        toolCalls: [],
        createdAt: 1,
        hookCards: [
          card({
            id: 'h-halt',
            event: 'stop',
            kind: 'halt',
            status: 'halted',
            durationMs: 0,
            stopReason: 'budget exhausted',
          }),
        ],
      },
    ])

    const haltCard = document.querySelector<HTMLElement>('.hook-card[data-hook-kind="halt"]')
    assert.ok(haltCard, 'a halt card renders')
    assert.equal(haltCard.getAttribute('data-status'), 'halted')
    assert.match(haltCard.textContent, /budget exhausted/)
  })

  it('reads the injected context on demand instead of only reporting its length', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    const asked: string[] = []
    const base = fakeApi()
    const api: ApiClient = {
      ...base,
      hooks: {
        ...base.hooks,
        runDetail: (_projectId, _threadId, runId) => {
          asked.push(runId)
          return Promise.resolve({
            found: true,
            event: 'beforeFinalize',
            executor: 'function',
            durationMs: 3,
            outcome: JSON.stringify({ injectContext: 'You still have open todos.' }),
          })
        },
      },
    }
    mountConversation(host, store, api)
    store.setState({ activeProjectId: 'project-1' })

    seedThread(store, [
      {
        id: 'a1',
        role: 'assistant',
        content: 'wrapping up',
        toolCalls: [],
        createdAt: 1,
        hookCards: [
          card({
            id: 'h-context',
            event: 'beforeFinalize',
            hookId: 'todo-finalize-closeout',
            executor: 'function',
            injectContextChars: 26,
          }),
        ],
      },
    ])

    const inspector = document.querySelector<HTMLDetailsElement>('.hook-card-raw')
    assert.ok(inspector, 'every card offers an inspector')
    // Lazy: a transcript full of cards must not fetch every blob it renders.
    assert.deepEqual(asked, [], 'nothing is fetched until the inspector is opened')

    await openInspector(inspector)
    assert.deepEqual(asked, ['h-context'], 'the spine run id is what gets fetched')
    const section = inspector.querySelector('[data-section="injected context"]')
    assert.ok(section, 'the applied channel is labeled, not dumped as JSON')
    assert.match(section.querySelector('pre')?.textContent ?? '', /You still have open todos\./)

    // Immutable once recorded: reopening must not re-fetch.
    inspector.open = false
    await openInspector(inspector)
    assert.deepEqual(asked, ['h-context'])
  })

  it('says why an inspector is empty rather than showing a blank box', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    const base = fakeApi()
    const api: ApiClient = {
      ...base,
      hooks: { ...base.hooks, runDetail: () => Promise.resolve({ found: false }) },
    }
    mountConversation(host, store, api)
    store.setState({ activeProjectId: 'project-1' })

    seedThread(store, [
      {
        id: 'a1',
        role: 'assistant',
        content: 'working',
        toolCalls: [],
        createdAt: 1,
        hookCards: [card({ id: 'h-live', status: 'ok' })],
      },
    ])

    const inspector = document.querySelector<HTMLDetailsElement>('.hook-card-raw')
    assert.ok(inspector)
    await openInspector(inspector)
    assert.match(
      inspector.querySelector('.hook-card-raw-status')?.textContent ?? '',
      /not recorded/,
    )
  })

  it('appends a live hook card to the current turn (hook_run chunk path)', () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const threadId = seedThread(store, [
      { id: 'a-live', role: 'assistant', content: 'working', toolCalls: [], createdAt: 1 },
    ])
    store.setState({ activeThreadId: threadId })

    assert.equal(document.querySelector('[data-hook-cards-for="a-live"]'), null)
    addHookCard(store, 'a-live', card({ id: 'h-live', event: 'afterToolUse', status: 'ok' }))

    const liveHost = document.querySelector<HTMLElement>('[data-hook-cards-for="a-live"]')
    assert.ok(liveHost, 'the live hook card renders after its message')
    assert.equal(liveHost.querySelectorAll('.hook-card').length, 1)
    // A re-delivered chunk with the same spine id does not double the card.
    addHookCard(store, 'a-live', card({ id: 'h-live', event: 'afterToolUse', status: 'ok' }))
    assert.equal(
      document.querySelectorAll('[data-hook-cards-for="a-live"] .hook-card').length,
      1,
      'dedup by spine id',
    )
  })
})
