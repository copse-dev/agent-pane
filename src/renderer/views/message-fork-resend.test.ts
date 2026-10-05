import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult } from '@shared/types'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from '../controller/message-queue.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'

// Component-level cover for the per-prompt actions on a user bubble. The pure
// transforms are unit-tested (shared/store/fork-thread.test.ts,
// main/services/thread-fork.test.ts) and the controllers in
// controller/{fork-thread,resend-message}.test.ts; what this pins is the RENDER
// + WIRING — which bubbles carry which buttons, and that clicking them drives
// the controllers. The visual eval is tests/e2e/message-fork-resend.e2e.ts.

type ForkCall = [projectId: string, source: string, target: string, through: string | undefined]

/** Records runs + forks; the rest of the preload surface is the demo double. */
function fakeApi(): { api: ApiClient; runs: Array<[string, string]>; forks: ForkCall[] } {
  const runs: Array<[string, string]> = []
  const forks: ForkCall[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      run: (_projectId: string, threadId: string, payload: string) => {
        runs.push([threadId, payload])
        return Promise.resolve()
      },
    },
    threads: {
      ...base.threads,
      fork: (projectId: string, source: string, target: string, through?: string) => {
        forks.push([projectId, source, target, through])
        const result: ForkedHistoryResult = { source: 'copied', messageCount: 2 }
        return Promise.resolve(result)
      },
    },
  }
  return { api, runs, forks }
}

/** Mount the real conversation view over a two-exchange thread. */
function mountConversationWithHistory(): {
  store: ReturnType<typeof createStore>
  runs: Array<[string, string]>
  forks: ForkCall[]
  threadId: string
} {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const { api, runs, forks } = fakeApi()
  const threadId = createThread(store)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, api)
  addMessage(store, threadId, 'user', 'First question')
  addMessage(store, threadId, 'assistant', 'First answer')
  addMessage(store, threadId, 'user', 'Second question')
  addMessage(store, threadId, 'assistant', 'Second answer')
  return { store, runs, forks, threadId }
}

function userBubbles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.messages-list .msg-user'))
}

afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
})

describe('per-prompt fork + resend actions (component)', () => {
  it('offers Fork from here on every prompt and Resend only on the latest', () => {
    mountConversationWithHistory()

    const bubbles = userBubbles()
    assert.equal(bubbles.length, 2)
    for (const bubble of bubbles) {
      assert.ok(bubble.querySelector('.msg-fork'), 'expected a fork button on every prompt')
    }
    const resends = bubbles.map((b) => b.querySelector<HTMLButtonElement>('.msg-resend'))
    assert.equal(resends[0]?.hidden, true)
    assert.equal(resends[1]?.hidden, false)
  })

  it('leaves assistant replies with Copy and Side chat alone — no fork or resend', () => {
    mountConversationWithHistory()

    const assistant = document.querySelector('.messages-list .msg-assistant')
    assert.ok(assistant)
    assert.equal(assistant.querySelector('.msg-fork'), null)
    assert.equal(assistant.querySelector('.msg-resend'), null)
    assert.ok(assistant.querySelector('.msg-copy'))
    assert.ok(assistant.querySelector('.msg-side-chat'), 'a reply can start a side chat')
  })

  it('offers Side chat on a prompt and starts one anchored on it without leaving the thread', async () => {
    const { store, forks, threadId } = mountConversationWithHistory()
    const bubble = userBubbles()[0]
    assert.ok(bubble)
    const anchorId = bubble.dataset['messageId']
    const opened: string[] = []
    store.on('side_chat_open_requested', (id) => opened.push(id))

    bubble.querySelector<HTMLButtonElement>('.msg-side-chat')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(store.getState().activeThreadId, threadId, 'the main thread stays open')
    assert.equal(opened.length, 1)
    const side = store.getState().threads.find((t) => t.id === opened[0])
    assert.deepEqual(side?.sideChat, { parentThreadId: threadId, anchorMessageId: anchorId })
    assert.deepEqual(forks, [['project-1', threadId, opened[0], anchorId]])
    // The branched message now carries a chip that reopens the side chat.
    // The list may rebuild its elements on the thread change; look the bubble up again.
    const chip = userBubbles()[0]?.querySelector<HTMLButtonElement>('.msg-side-chat-chip')
    assert.ok(chip)
    assert.equal(chip.textContent, '1 side chat')
    chip.click()
    assert.equal(opened.length, 2)
  })

  it('Fork from here branches the conversation at that prompt into a new thread', async () => {
    const { store, forks, threadId } = mountConversationWithHistory()
    const firstBubble = userBubbles()[0]
    assert.ok(firstBubble)
    const forkPointId = firstBubble.dataset['messageId']

    firstBubble.querySelector<HTMLButtonElement>('.msg-fork')?.click()
    const forkCopy = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((item) => item.textContent === 'Fork a copy')
    assert.ok(forkCopy)
    forkCopy.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const activeId = store.getState().activeThreadId
    assert.ok(activeId)
    assert.notEqual(activeId, threadId)
    assert.deepEqual(
      store
        .getState()
        .threads.find((t) => t.id === activeId)
        ?.messages.map((m) => m.content),
      ['First question'],
    )
    assert.deepEqual(forks, [['project-1', threadId, activeId, forkPointId]])
  })

  it('Resend submits the latest prompt again as a new turn', () => {
    const { store, runs, threadId } = mountConversationWithHistory()

    const latest = userBubbles()[1]
    latest?.querySelector<HTMLButtonElement>('.msg-resend')?.click()

    const thread = store.getState().threads.find((t) => t.id === threadId)
    assert.deepEqual(
      thread?.messages.map((m) => m.content),
      ['First question', 'First answer', 'Second question', 'Second answer', 'Second question'],
    )
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.[0], threadId)
  })

  it('moves Resend onto the newly sent prompt', () => {
    const { store, threadId } = mountConversationWithHistory()

    addMessage(store, threadId, 'user', 'Third question')

    const resends = userBubbles().map((b) => b.querySelector<HTMLButtonElement>('.msg-resend'))
    assert.deepEqual(
      resends.map((r) => r?.hidden),
      [true, true, false],
    )
  })

  it('keeps the actions off a queued follow-up, which has its own controls', () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const { api } = fakeApi()
    const threadId = createThread(store)
    setThreadStatus(store, threadId, 'running')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)
    const messageId = addMessage(store, threadId, 'user', 'Queued follow-up')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'Queued follow-up' },
      createdAt: 1,
    })

    assert.ok(document.querySelector('.conversation-queued .msg-queued'))
    assert.equal(document.querySelector('.conversation-queued .msg-actions'), null)
    assert.equal(document.querySelector('.messages-list .msg-actions'), null)
  })
})
