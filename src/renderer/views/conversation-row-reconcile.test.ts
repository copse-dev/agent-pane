import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  patchThreadAnywhere,
  setMessageTurnOutcome,
  setThreadStatus,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// The transcript reconciles its message rows by message id (transcript-rows.ts)
// when what it draws changes. A row whose message did not change must survive
// by identity, with everything that arrived after it was built: a resolved
// file-reference link (an async decoration) and the reader's open disclosure.
// Before the reconciler, any such change cleared the list and rebuilt every
// row, dropping both until they were resolved or reopened again.

function fakeApi(resolveCalls: { count: number }): ApiClient {
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
      resolveFileReferences: (
        candidates,
      ): ReturnType<ApiClient['index']['resolveFileReferences']> => {
        resolveCalls.count++
        return Promise.resolve(
          candidates.map((candidate) => ({ candidate, path: candidate, kind: 'file' as const })),
        )
      },
    },
  } satisfies ApiClient
}

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.replaceChildren()
})

interface Seeded {
  store: ReturnType<typeof createStore>
  threadId: string
  prompt: string
  answer: string
  resolveCalls: { count: number }
}

/** One finished turn: a prompt, and an answer with a file path and a tool card. */
async function seed(): Promise<Seeded> {
  // The turn-recovery card needs a project to retry in.
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  const prompt = addMessage(store, threadId, 'user', 'Where are palette entries built?')
  const answer = addMessage(
    store,
    threadId,
    'assistant',
    'The palette builds entries in `src/renderer/views/command-palette.ts`.',
  )
  addToolCall(store, answer, {
    id: 'tc-read',
    name: 'read_file',
    args: { path: 'src/renderer/views/command-palette.ts' },
    status: 'done',
    result: 'export function mountCommandPalette() {}',
  })
  const resolveCalls = { count: 0 }
  const host = document.createElement('div')
  document.body.append(host)
  unmounts.push(mountConversation(host, store, fakeApi(resolveCalls)))
  await delay(0)
  return { store, threadId, prompt, answer, resolveCalls }
}

function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.messages-list > [data-message-id="${id}"]`)
}

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.messages-list > [data-message-id]'),
    (element) => element.dataset['messageId'] ?? '',
  )
}

describe('conversation keyed row reconcile (component)', () => {
  it('keeps unchanged rows, their resolved links and open disclosures across a new turn', async () => {
    const { store, threadId, prompt, answer, resolveCalls } = await seed()
    const promptNode = row(prompt)
    const answerNode = row(answer)
    assert.ok(promptNode && answerNode)
    const link = answerNode.querySelector('a.file-reference-link')
    assert.ok(link, 'expected the inline path to resolve into a file-reference link')
    const card = qsRequired<HTMLDetailsElement>(answerNode, '[data-tool-id="tc-read"]')
    qsRequired(card, ':scope > summary').click()
    assert.equal(card.open, true, 'the reader opened the tool card')
    const resolvesBefore = resolveCalls.count

    // A second turn starts and ends. Every step changes what the transcript
    // draws (a new message array, then the status), and each is followed by
    // the coarse threads_changed that used to rebuild every row.
    const next = addMessage(store, threadId, 'user', 'And the tests?')
    setThreadTitle(store, threadId, 'Palette entries')
    setThreadStatus(store, threadId, 'running')
    const reply = addMessage(store, threadId, 'assistant', 'In command-palette.test.ts.')
    setThreadStatus(store, threadId, 'idle')
    store.emit('threads_changed')
    await delay(0)

    assert.deepEqual(rowIds(), [prompt, answer, next, reply])
    // assert.ok, not assert.equal: a failing equal on DOM nodes makes node
    // inspect them, which hangs on happy-dom's object graph.
    assert.ok(row(prompt) === promptNode, 'the first prompt row was rebuilt')
    assert.ok(row(answer) === answerNode, 'the first answer row was rebuilt')
    assert.ok(
      answerNode.querySelector('a.file-reference-link') === link,
      'the resolved link was lost',
    )
    assert.ok(
      answerNode.querySelector('[data-tool-id="tc-read"]') === card,
      'the tool card was rebuilt',
    )
    assert.equal(card.open, true, 'the open disclosure was closed')
    assert.equal(
      resolveCalls.count - resolvesBefore,
      1,
      'only the new reply resolves its paths; the kept answer does not resolve again',
    )
  })

  it('patches a changed row in place and drops a removed one, keeping the rest', async () => {
    const { store, threadId, prompt, answer } = await seed()
    const second = addMessage(store, threadId, 'user', 'Second prompt')
    const third = addMessage(store, threadId, 'assistant', 'Third reply')
    const promptNode = row(prompt)
    const secondNode = row(second)
    assert.ok(promptNode && secondNode)

    // An edit replaces one message object and truncates the last one away.
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      messages: thread.messages
        .filter((message) => message.id !== third)
        .map((message) =>
          message.id === answer ? { ...message, content: 'Edited answer.' } : message,
        ),
    }))
    store.emit('threads_changed')

    assert.deepEqual(rowIds(), [prompt, answer, second])
    assert.ok(row(prompt) === promptNode, 'an unchanged row before the edit was rebuilt')
    assert.ok(row(second) === secondNode, 'an unchanged row after the edit was rebuilt')
    assert.match(row(answer)?.textContent ?? '', /Edited answer\./)
    assert.equal(document.querySelectorAll('.messages-list > [data-message-id]').length, 3)
  })

  it('rebuilds the turn-recovery card with the failed last row only', async () => {
    const { store, threadId, prompt, answer } = await seed()
    const promptNode = row(prompt)
    assert.ok(promptNode)
    setThreadStatus(store, threadId, 'running')
    store.emit('threads_changed')
    // The turn ends with a provider failure: the outcome lands on the last
    // message (its own threads_changed), then the status settles.
    setMessageTurnOutcome(store, threadId, answer, {
      status: 'failed',
      stopReason: 'error',
      source: 'provider',
      executor: 'local',
      provider: 'openai',
      model: 'gpt',
      endedAt: 2,
    })
    setThreadStatus(store, threadId, 'error')
    store.emit('threads_changed')

    assert.ok(row(prompt) === promptNode, 'the prompt row was rebuilt')
    assert.equal(document.querySelectorAll(`[data-turn-recovery-for="${answer}"]`).length, 1)
    const recovery = document.querySelector(`[data-turn-recovery-for="${answer}"]`)
    assert.ok(recovery?.previousElementSibling === row(answer), 'recovery follows its message')
  })
})
