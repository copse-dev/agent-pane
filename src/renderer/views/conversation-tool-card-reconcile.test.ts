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

// Regression cover for #728: `tool_call_updated` fires continuously while a
// subagent runs. The old renderer removed every `.tool-card` and rebuilt the
// whole subtree each tick, so sibling cards and the running subagent's streamed
// markdown (plus its copy buttons) flickered. These tests pin the reconciling
// behaviour: unchanged cards keep their DOM identity across a tick, and the
// running subagent's streaming message element (hence its renderer) survives.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: { resolveFileReferences: () => Promise.resolve([]) },
  } as unknown as ApiClient
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

function runningSubagent(content: string): ToolCall {
  const session: SubagentSession = {
    id: 'sub-session-1',
    kind: 'explore',
    status: 'running',
    prompt: 'Find README',
    summary: null,
    messages: [{ id: 'sub-msg-1', role: 'assistant', content, toolCalls: [] }],
  }
  return {
    id: 'tc-sub-1',
    name: 'explore',
    args: { query: 'Find README' },
    status: 'running',
    result: null,
    subagent: session,
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
      subagent: runningSubagent('Analyzing the').subagent,
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
    assert.ok(streamBefore, 'expected a streaming subagent message element')
    // Tag the element so recreation (not just a moved node) is detectable.
    ;(streamBefore as HTMLElement).dataset['sentinel'] = 'kept'

    updateToolCall(store, messageId, 'tc-sub-1', {
      subagent: runningSubagent('Analyzing the code').subagent,
    })

    const cardAfter = host.querySelector('.tool-card-subagent')
    assert.strictEqual(
      cardAfter,
      cardBefore,
      'subagent card was rebuilt instead of updated in place',
    )
    const streamAfter = cardAfter.querySelector('.subagent-message-assistant')
    assert.strictEqual(streamAfter, streamBefore, 'streaming message element was recreated')
    assert.equal((streamAfter as HTMLElement).dataset['sentinel'], 'kept')
    assert.match(streamAfter.textContent, /Analyzing the code/)
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
