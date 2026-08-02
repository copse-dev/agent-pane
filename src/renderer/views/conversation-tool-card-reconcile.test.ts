import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { SubagentSession, ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Regression cover for #728: `tool_call_updated` fires continuously while a
// subagent runs. The old renderer removed every `.tool-card` and rebuilt the
// whole subtree each tick, so sibling cards and the running subagent's streamed
// markdown (plus its copy buttons) flickered. These tests pin the reconciling
// behaviour: unchanged cards keep their DOM identity across a tick, and the
// running subagent's streaming message element (hence its renderer) survives.

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
      index: {
        ...base['index'],
        resolveFileReferences: () => Promise.resolve([]),
      },
    } satisfies ApiClient
  })()
}

// A sibling in a different group ('writing') so it stays its own individual
// card and the lone explore stays a subagent card (both grouping otherwise as
// 'reading' would merge them into one group card).
const editCall: ToolCall = {
  id: 'tc-edit-1',
  name: 'write_file',
  args: { path: 'notes.md' },
  status: 'done',
  result: 'ok',
}

function subagentSession(content: string): SubagentSession {
  return {
    id: 'sub-session-1',
    kind: 'explore',
    status: 'running',
    prompt: 'Find README',
    summary: null,
    messages: [{ id: 'sub-msg-1', role: 'assistant', content, toolCalls: [] }],
  }
}

function runningSubagent(content: string): ToolCall {
  return {
    id: 'tc-sub-1',
    name: 'explore',
    args: { query: 'Find README' },
    status: 'running',
    result: null,
    subagent: subagentSession(content),
  }
}

function mountWithCards(): {
  store: ReturnType<typeof createStore>
  messageId: string
  host: HTMLElement
} {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'assistant', 'Working…')
  // A completed sibling card, then the still-running subagent.
  addToolCall(store, messageId, editCall)
  addToolCall(store, messageId, runningSubagent('Analyzing'))
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, messageId, host }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('tool card reconciliation on tool_call_updated (#728)', () => {
  it('reuses an unchanged sibling card across a subagent tick', () => {
    const { store, messageId, host } = mountWithCards()

    const editBefore = host.querySelector('[data-tool-id="tc-edit-1"]')
    assert.ok(editBefore, 'expected the sibling edit card to render')

    // A progress tick that only grows the subagent's streamed text.
    updateToolCall(store, messageId, 'tc-sub-1', {
      subagent: subagentSession('Analyzing the'),
    })

    const editAfter = host.querySelector('[data-tool-id="tc-edit-1"]')
    assert.strictEqual(
      editAfter,
      editBefore,
      'unchanged sibling card was rebuilt instead of reused',
    )
  })

  it('keeps the running subagent card and its streaming message element across ticks', () => {
    const { store, messageId, host } = mountWithCards()

    const cardBefore = host.querySelector('.tool-card-subagent')
    assert.ok(cardBefore)
    const streamBefore = cardBefore.querySelector('.subagent-message-assistant')
    assert.ok(streamBefore instanceof HTMLElement, 'expected a streaming subagent message element')
    // Tag the element so recreation (not just a moved node) is detectable.
    streamBefore.dataset['sentinel'] = 'kept'

    updateToolCall(store, messageId, 'tc-sub-1', {
      subagent: subagentSession('Analyzing the code'),
    })

    const cardAfter = host.querySelector('.tool-card-subagent')
    assert.strictEqual(
      cardAfter,
      cardBefore,
      'subagent card was rebuilt instead of updated in place',
    )
    const streamAfter = cardAfter.querySelector('.subagent-message-assistant')
    assert.strictEqual(streamAfter, streamBefore, 'streaming message element was recreated')
    assert.ok(streamAfter instanceof HTMLElement)
    assert.equal(streamAfter.dataset['sentinel'], 'kept')
    assert.match(streamAfter.textContent, /Analyzing the code/)
  })

  it('keeps subagent chrome (header + timeline) across a streaming tick', () => {
    // #788 stopped recreating the streaming message, but populateSubagentCard
    // still cleared the card and rebuilt the header/timeline shell every token
    // — visible flicker on the status icon and disclosure chrome.
    const { store, messageId, host } = mountWithCards()

    const card = host.querySelector('.tool-card-subagent')
    assert.ok(card)
    const headerBefore = card.querySelector('.tool-card-header')
    const timelineBefore = card.querySelector('.subagent-timeline')
    assert.ok(headerBefore)
    assert.ok(timelineBefore)

    updateToolCall(store, messageId, 'tc-sub-1', {
      subagent: subagentSession('Analyzing the repo'),
    })

    assert.strictEqual(
      card.querySelector('.tool-card-header'),
      headerBefore,
      'header was rebuilt on a streaming tick',
    )
    assert.strictEqual(
      card.querySelector('.subagent-timeline'),
      timelineBefore,
      'timeline shell was rebuilt on a streaming tick',
    )
  })

  it('keeps a live explore card when a sibling read_file would otherwise group it', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, runningSubagent('Looking'))
    addToolCall(store, messageId, {
      id: 'tc-read-1',
      name: 'read_file',
      args: { path: 'README.md' },
      status: 'done',
      result: '# Copse',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const cardBefore = host.querySelector('.tool-card-subagent')
    assert.ok(cardBefore, 'expected an individual subagent card, not a reading group')
    assert.equal(host.querySelectorAll('.tool-card-group').length, 0)

    updateToolCall(store, messageId, 'tc-sub-1', {
      subagent: subagentSession('Looking at README'),
    })

    assert.strictEqual(
      host.querySelector('.tool-card-subagent'),
      cardBefore,
      'subagent card was absorbed into a group (or rebuilt) when a read sibling was present',
    )
    assert.match(
      host.querySelector('.subagent-message-assistant')?.textContent ?? '',
      /Looking at README/,
    )
  })

  it('replaces a rebuilt card instead of leaving the stale one behind', () => {
    const { store, messageId, host } = mountWithCards()

    const editBefore = host.querySelector('[data-tool-id="tc-edit-1"]')
    assert.ok(editBefore, 'expected the sibling edit card to render')

    // The edit call changes, so its card is rebuilt (signature mismatch). The
    // reconciler claims the old node out of its `existing` index before the
    // rebuild, so the trailing cleanup never saw it — the stale card used to
    // stay in the DOM next to the fresh one.
    updateToolCall(store, messageId, 'tc-edit-1', { result: 'wrote 2 lines' })

    const editCards = host.querySelectorAll('[data-tool-id="tc-edit-1"]')
    assert.equal(editCards.length, 1, 'rebuilt card must replace the stale node')
    assert.notStrictEqual(editCards[0], editBefore, 'changed card should be rebuilt')
    // The card starts collapsed, so its body (including .tool-result) isn't
    // built until it opens — opening it is what triggers the deferred render.
    editCards[0]?.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    assert.match(editCards[0]?.querySelector('.tool-result')?.textContent ?? '', /wrote 2 lines/)
  })

  it('re-renders a card whose tool call actually changed', () => {
    const { store, messageId, host } = mountWithCards()

    // The subagent finishes: status flips to done and a summary/result arrives.
    const doneSession: SubagentSession = {
      id: 'sub-session-1',
      kind: 'explore',
      status: 'done',
      prompt: 'Find README',
      summary: 'README describes Copse setup.',
      messages: [
        { id: 'sub-msg-1', role: 'assistant', content: 'Analyzing the code', toolCalls: [] },
      ],
    }
    updateToolCall(store, messageId, 'tc-sub-1', {
      status: 'done',
      result: 'README describes Copse setup.',
      subagent: doneSession,
    })

    const card = host.querySelector('.tool-card-subagent')
    assert.ok(card)
    assert.equal(card.getAttribute('data-status'), 'done')
    // The parent result renders only once the run settles.
    assert.ok(card.querySelector('.subagent-parent-result'), 'expected the settled parent result')
  })
})
