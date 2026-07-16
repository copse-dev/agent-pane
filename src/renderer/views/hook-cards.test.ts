import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addHookCard, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { HookCard, Message } from '@shared/types'
import { mountConversation } from './conversation.ts'

// Component-tier coverage of the decision-10 hook-card family: the pure model +
// spine mapping is unit-tested in shared/hooks/hook-card.test.ts and the fold
// attach in shared/threads/fold.test.ts; this pins the *rendering* — the
// right-aligned blue card family, the executions/decisions/halts, and the
// origin marker on a hook-originated turn — without Electron.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
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
