import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startAgentController } from './agent.ts'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { Message, Thread, StreamChunk } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'

function at<T>(arr: readonly T[], i: number): T {
  const value = arr[i]
  if (value === undefined) throw new Error(`expected element at index ${String(i)}`)
  return value
}

function requireThread(store: AppStore, id: string): Thread {
  const found = getThreadById(store, id)
  if (!found) throw new Error(`expected thread '${id}' to exist`)
  return found
}

function thread(id: string, messages: Message[] = [], branch?: string): Thread {
  const value: Thread = {
    id,
    title: id, // not 'New Thread', so auto-naming on `done` is skipped
    status: 'running',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  if (branch) value.gitBranch = branch
  return value
}

// The controller registers an `agent.onChunk` handler and subscribes to usage +
// diff IPC. Capture the chunk handler so tests can drive synthetic stream
// chunks, and hand back noop unsubscribers for the rest.
function setup(
  initial: Thread[] = [thread('t1')],
  activeThreadId = 't1',
  options?: { currentBranch?: string | null },
): {
  store: AppStore
  send: (chunk: StreamChunk, threadId?: string) => void
  unsub: () => void
  titleCalls: string[]
  messageDone: string[]
  messages: (id?: string) => Message[]
  gitBranchChanged: number[]
} {
  const store = createStore({ threads: initial, activeThreadId })
  let chunkHandler: ((threadId: string, chunk: StreamChunk) => void) | null = null
  const titleCalls: string[] = []
  const messageDone: string[] = []
  const gitBranchChanged: number[] = []
  store.on('message_done', (id) => messageDone.push(id))
  store.on('git_branch_changed', () => gitBranchChanged.push(1))

  const api = {
    agent: {
      onChunk: (h: (threadId: string, chunk: StreamChunk) => void) => {
        chunkHandler = h
        return (): void => {}
      },
      onUsage: () => (): void => {},
      suggestTitle: async (text: string) => {
        titleCalls.push(text)
        return 'Generated Title'
      },
    },
    diff: {
      onShowDiff: () => (): void => {},
      onQueued: () => (): void => {},
    },
    git: {
      branchStatus: async () => ({
        currentBranch: options?.currentBranch ?? null,
        pr: null,
      }),
    },
    usage: {
      record: async () => {},
      getSummary: async () => ({
        day: {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        month: {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        period90d: {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        allTime: {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        trackingStartedAt: null,
        ledgerEventCount: 0,
      }),
    },
  } as unknown as ApiClient

  const unsub = startAgentController(store, api)
  const send = (chunk: StreamChunk, threadId = 't1'): void => {
    if (!chunkHandler) throw new Error('startAgentController did not register a chunk handler')
    chunkHandler(threadId, chunk)
  }
  const messages = (id = 't1'): Message[] => requireThread(store, id).messages
  return { store, send, unsub, titleCalls, messageDone, messages, gitBranchChanged }
}

test('text chunks create one assistant message and accumulate tokens', () => {
  const { send, messages } = setup()
  send({ type: 'text', text: 'Hello' })
  send({ type: 'text', text: ' world' })

  assert.equal(messages().length, 1)
  assert.equal(at(messages(), 0).role, 'assistant')
  assert.equal(at(messages(), 0).content, 'Hello world')
})

test('whitespace-only text before any message is ignored', () => {
  const { send, messages } = setup()
  send({ type: 'text', text: '   ' })
  assert.equal(messages().length, 0)
})

test('text_replace overwrites accumulated assistant content', () => {
  const { send, messages } = setup()
  send({ type: 'text', text: 'draft <tool/> tail' })
  send({ type: 'text_replace', text: 'cleaned' })
  assert.equal(at(messages(), 0).content, 'cleaned')
})

test('tool_call then tool_result transitions the tool card running -> done', () => {
  const { send, messages } = setup()
  send({ type: 'text', text: 'looking' })
  send({ type: 'tool_call', toolCall: { id: 'tc1', name: 'read_file', args: { path: 'a.ts' } } })

  let tc = at(at(messages(), 0).toolCalls, 0)
  assert.equal(tc.status, 'running')
  assert.equal(tc.name, 'read_file')

  send({ type: 'tool_result', toolCallId: 'tc1', result: 'file body', isError: false })
  tc = at(at(messages(), 0).toolCalls, 0)
  assert.equal(tc.status, 'done')
  assert.equal(tc.result, 'file body')
})

test('tool_result with isError marks the tool card as error', () => {
  const { send, messages } = setup()
  send({ type: 'tool_call', toolCall: { id: 'tc1', name: 'read_file', args: {} } })
  send({ type: 'tool_result', toolCallId: 'tc1', result: 'boom', isError: true })
  assert.equal(at(at(messages(), 0).toolCalls, 0).status, 'error')
})

test('successful run_shell rebinds the thread when checkout changed', async () => {
  const { send, store, gitBranchChanged } = setup([thread('t1', [], 'main')], 't1', {
    currentBranch: 'claude/compassionate-wright-a1awji',
  })
  send({
    type: 'tool_call',
    toolCall: {
      id: 'tc1',
      name: 'run_shell',
      args: { command: 'git checkout claude/compassionate-wright-a1awji' },
    },
  })
  send({ type: 'tool_result', toolCallId: 'tc1', result: 'Switched to branch', isError: false })
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't1').gitBranch, 'claude/compassionate-wright-a1awji')
  assert.equal(gitBranchChanged.length, 1)
})

test('successful run_shell does not rebind when checkout is unchanged', async () => {
  const { send, store, gitBranchChanged } = setup([thread('t1', [], 'main')], 't1', {
    currentBranch: 'main',
  })
  send({
    type: 'tool_call',
    toolCall: { id: 'tc1', name: 'run_shell', args: { command: 'npm test' } },
  })
  send({ type: 'tool_result', toolCallId: 'tc1', result: 'ok', isError: false })
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't1').gitBranch, 'main')
  assert.equal(gitBranchChanged.length, 0)
})

test('run_shell does not rebind a background (non-active) thread', async () => {
  const { send, store, gitBranchChanged } = setup(
    [thread('t1', [], 'main'), thread('t2', [], 'main')],
    't2',
    { currentBranch: 'claude/compassionate-wright-a1awji' },
  )
  send(
    {
      type: 'tool_call',
      toolCall: {
        id: 'tc1',
        name: 'run_shell',
        args: { command: 'git checkout claude/compassionate-wright-a1awji' },
      },
    },
    't1',
  )
  send(
    { type: 'tool_result', toolCallId: 'tc1', result: 'Switched to branch', isError: false },
    't1',
  )
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't1').gitBranch, 'main')
  assert.equal(gitBranchChanged.length, 0)
})

test('text after a tool call finalizes the prior bubble and starts a new one below', () => {
  const { send, messages, messageDone } = setup()
  send({ type: 'text', text: 'thinking' })
  send({ type: 'tool_call', toolCall: { id: 'tc1', name: 'read_file', args: {} } })
  send({ type: 'text', text: 'final answer' })

  const msgs = messages()
  assert.equal(msgs.length, 2)
  // First bubble keeps its text + the tool card; the final answer renders below.
  assert.equal(at(msgs, 0).content, 'thinking')
  assert.equal(at(msgs, 0).toolCalls.length, 1)
  assert.equal(at(msgs, 1).content, 'final answer')
  assert.equal(at(msgs, 1).toolCalls.length, 0)
  // The first bubble was finalized when text resumed.
  assert.deepEqual(messageDone, [at(msgs, 0).id])
})

test('reasoning chunks accumulate onto the message that carries the answer', () => {
  const { send, messages } = setup()
  send({ type: 'reasoning', text: 'Let me ' })
  send({ type: 'reasoning', text: 'think.' })
  send({ type: 'text', text: 'Done.' })

  const msgs = messages()
  assert.equal(msgs.length, 1)
  assert.equal(at(msgs, 0).reasoning, 'Let me think.')
  assert.equal(at(msgs, 0).content, 'Done.')
})

test('reasoning after a tool call starts a fresh bubble for the next step', () => {
  const { send, messages, messageDone } = setup()
  send({ type: 'reasoning', text: 'first' })
  send({ type: 'tool_call', toolCall: { id: 'tc1', name: 'read_file', args: {} } })
  send({ type: 'tool_result', toolCallId: 'tc1', result: 'ok', isError: false })
  send({ type: 'reasoning', text: 'second' })
  send({ type: 'text', text: 'answer' })

  const msgs = messages()
  assert.equal(msgs.length, 2)
  // First bubble: pre-tool reasoning + the tool card.
  assert.equal(at(msgs, 0).reasoning, 'first')
  assert.equal(at(msgs, 0).toolCalls.length, 1)
  // Second bubble: the next step's reasoning groups with its answer.
  assert.equal(at(msgs, 1).reasoning, 'second')
  assert.equal(at(msgs, 1).content, 'answer')
  assert.deepEqual(messageDone, [at(msgs, 0).id])
})

test('usage chunks accumulate into the thread total and per-model breakdown', () => {
  const { store, send } = setup()
  send({ type: 'usage', model: 'm1', inputTokens: 10, outputTokens: 4 })
  send({ type: 'usage', model: 'm1', inputTokens: 5, outputTokens: 1 })

  const usage = requireThread(store, 't1').usage
  assert.equal(usage.inputTokens, 15)
  assert.equal(usage.outputTokens, 5)
  assert.deepEqual(usage.byModel?.['m1'], { inputTokens: 15, outputTokens: 5 })
})

test('done finalizes the message, sets the thread idle, and resets stream state', () => {
  const { send, messages, messageDone, store } = setup()
  send({ type: 'text', text: 'answer' })
  const firstId = at(messages(), 0).id
  send({ type: 'done' })

  assert.equal(requireThread(store, 't1').status, 'idle')
  assert.deepEqual(messageDone, [firstId])

  // State was cleared, so a subsequent text chunk opens a fresh bubble.
  send({ type: 'text', text: 'next turn' })
  assert.equal(messages().length, 2)
  assert.equal(at(messages(), 1).content, 'next turn')
})

test('done auto-names a "New Thread" from its first user message', async () => {
  const userMsg: Message = {
    id: 'u1',
    role: 'user',
    content: 'Add a login button',
    toolCalls: [],
    createdAt: 1,
  }
  const named = thread('t-name', [userMsg])
  named.title = 'New Thread'
  const { send, titleCalls, store } = setup([named], 't-name')

  send({ type: 'text', text: 'sure' }, 't-name')
  send({ type: 'done' }, 't-name')
  // suggestTitle is awaited inside maybeNameThread; let the microtask settle.
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Add a login button'])
  assert.equal(requireThread(store, 't-name').title, 'Generated Title')
})
