import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  markThreadRead,
  patchThreadAnywhere,
  setMessageTurnOutcome,
  setThreadStatus,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import { createTranscriptReducer } from '@shared/store/transcript-reducer.ts'
import { ACP_CANCELLED_TOOL_CALL_RESULT } from '@shared/tools/tool-interruption.ts'
import {
  humanPrompt,
  recordedTurn,
  threadWith,
} from '@shared/store/transcript-stream.test-support.ts'
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

  it('leaves the transcript exactly as a fresh rebuild would draw it', async () => {
    // Drive the real stream reducer through a finished turn and a turn the
    // user stops mid-tool, with the coarse threads_changed between steps, then
    // compare every row with a second view mounted fresh on the same store.
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'What does the plan say?')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const live = document.createElement('div')
    document.body.append(live)
    unmounts.push(mountConversation(live, store, fakeApi({ count: 0 })))
    const reducer = createTranscriptReducer(store)
    for (const chunk of recordedTurn()) {
      reducer.apply('t1', chunk)
      store.emit('threads_changed')
    }
    markThreadRead(store, 't1')
    addMessage(store, 't1', 'user', 'Wait for my phone to stop this run.')
    setThreadStatus(store, 't1', 'running')
    store.emit('threads_changed')
    reducer.apply('t1', { type: 'reasoning', text: 'Waiting.' })
    reducer.apply('t1', {
      type: 'tool_call',
      toolCall: { id: 'call-wait', name: 'run_shell', args: { command: 'sleep 5' } },
    })
    // The Stop cancels the running command: the host records it as a cancelled
    // error, which the turn's user-cancel outcome relabels as interrupted.
    reducer.apply('t1', {
      type: 'tool_result',
      toolCallId: 'call-wait',
      result: ACP_CANCELLED_TOOL_CALL_RESULT,
      isError: true,
    })
    reducer.apply('t1', { type: 'text', text: 'This must be interrupted' })
    store.emit('threads_changed')
    reducer.apply('t1', {
      type: 'turn_outcome',
      outcome: {
        status: 'cancelled',
        stopReason: 'cancelled',
        source: 'user',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 99,
        userAbort: 'stop',
      },
    })
    reducer.apply('t1', { type: 'done' })
    markThreadRead(store, 't1')
    await delay(0)

    const fresh = document.createElement('div')
    document.body.append(fresh)
    unmounts.push(mountConversation(fresh, store, fakeApi({ count: 0 })))
    await delay(0)
    // The activity row outlives every rebuild, so it is the view's, not a row.
    const rows = (host: HTMLElement): string[] =>
      Array.from(
        host.querySelectorAll('.messages-list > :not(.agent-activity)'),
        (child) => child.outerHTML,
      )
    // The outcome lands on the reply bubble, but the interrupted command's card
    // lives on the bubble before it, which the Stop relabels all the same.
    const card = live.querySelector('[data-tool-id="call-wait"]')
    assert.equal(card?.getAttribute('data-status'), 'interrupted')
    const reconciled = rows(live)
    const rebuilt = rows(fresh)
    assert.equal(reconciled.length, rebuilt.length)
    const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
    assert.equal(firstDifference, -1, `row ${String(firstDifference)} differs from a rebuild`)
  })

  it('keeps a streamed reply, with its resolved link, once the turn ends', async () => {
    // The reply is built empty when the turn starts and filled in place by the
    // streaming handlers. Each re-stamps the row, so the reconcile that the
    // next turn triggers keeps it rather than rebuilding it from scratch.
    const resolveCalls = { count: 0 }
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'Where are palette entries built?')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const host = document.createElement('div')
    document.body.append(host)
    unmounts.push(mountConversation(host, store, fakeApi(resolveCalls)))
    const reducer = createTranscriptReducer(store)
    reducer.apply('t1', { type: 'reasoning', text: 'Look for the builder.' })
    // The bubble as the turn started it: built once, then only patched.
    const built = host.querySelector<HTMLElement>('.messages-list > .msg-assistant')
    assert.ok(built)
    reducer.apply('t1', { type: 'text', text: 'The palette builds entries in ' })
    reducer.apply('t1', { type: 'text', text: '`src/renderer/views/command-palette.ts`.' })
    reducer.apply('t1', {
      type: 'turn_outcome',
      outcome: {
        status: 'completed',
        stopReason: 'end_turn',
        source: 'provider',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 50,
      },
    })
    reducer.apply('t1', { type: 'done' })
    markThreadRead(store, 't1')
    await delay(0)

    const reply = host.querySelector<HTMLElement>('.messages-list > .msg-assistant')
    const link = reply?.querySelector('a.file-reference-link')
    assert.ok(reply && link, 'expected the streamed reply with its resolved file link')
    assert.ok(reply === built, 'the turn itself rebuilt the reply')
    const resolvesBefore = resolveCalls.count

    addMessage(store, 't1', 'user', 'And the tests?')
    store.emit('threads_changed')
    await delay(0)

    assert.ok(
      host.querySelector('.messages-list > .msg-assistant') === reply,
      'the streamed reply was rebuilt by the next reconcile',
    )
    assert.ok(reply.querySelector('a.file-reference-link') === link, 'the resolved link was lost')
    assert.equal(resolveCalls.count, resolvesBefore, 'the kept reply resolved its paths again')
  })
})
