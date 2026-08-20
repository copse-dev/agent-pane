import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { startAgentController } from './agent.ts'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { Message, Thread, StreamChunk } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'

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
    title: id,
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
  finishedAlerts: Array<{ threadId: string; title: string }>
  showDiff: (
    projectId: string,
    threadId: string,
    path: string,
    before: string,
    after: string,
    language: string,
  ) => void
  queueDiffs: (
    projectId: string,
    threadId: string,
    entries: { path: string; language: string }[],
  ) => void
} {
  const store = createStore({ activeProjectId: 'project-1', threads: initial, activeThreadId })
  let chunkHandler: ((threadId: string, chunk: StreamChunk) => void) | null = null
  let showDiffHandler:
    | ((
        projectId: string,
        threadId: string,
        path: string,
        before: string,
        after: string,
        language: string,
      ) => void)
    | null = null
  let queuedHandler:
    | ((projectId: string, threadId: string, entries: { path: string; language: string }[]) => void)
    | null = null
  const titleCalls: string[] = []
  const messageDone: string[] = []
  const gitBranchChanged: number[] = []
  const finishedAlerts: Array<{ threadId: string; title: string }> = []
  store.on('message_done', (id) => messageDone.push(id))
  store.on('git_branch_changed', () => gitBranchChanged.push(1))

  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: async (): Promise<void> => {},
        onChunk: (h: (threadId: string, chunk: StreamChunk) => void) => {
          chunkHandler = h
          return (): void => {}
        },
        onHookQueueMessage: () => (): void => {},
        suggestTitle: async (text: string): Promise<string | null> => {
          titleCalls.push(text)
          return 'Generated Title'
        },
      },
      diff: {
        ...base['diff'],
        onShowDiff: (handler: NonNullable<typeof showDiffHandler>) => {
          showDiffHandler = handler
          return (): void => {}
        },
        onQueued: (handler: NonNullable<typeof queuedHandler>) => {
          queuedHandler = handler
          return (): void => {}
        },
      },
      git: {
        ...base['git'],
        branchStatus: async () => ({
          currentBranch: options?.currentBranch ?? null,
          pr: null,
        }),
      },
      usage: {
        ...base['usage'],
        record: async (): Promise<void> => {},
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
        getPlanUsage: async () => ({
          checkedAt: new Date(0).toISOString(),
          providers: [
            {
              status: 'unavailable' as const,
              provider: 'claude' as const,
              reason: 'test',
            },
            {
              status: 'unavailable' as const,
              provider: 'codex' as const,
              reason: 'test',
            },
          ],
        }),
      },
      alerts: {
        threadFinished: async (threadId: string, title: string): Promise<void> => {
          finishedAlerts.push({ threadId, title })
        },
      },
    } satisfies ApiClient
  })()

  const unsub = startAgentController(store, api)
  const send = (chunk: StreamChunk, threadId = 't1'): void => {
    if (!chunkHandler) throw new Error('startAgentController did not register a chunk handler')
    chunkHandler(threadId, chunk)
  }
  const messages = (id = 't1'): Message[] => requireThread(store, id).messages
  const showDiff = (...args: Parameters<NonNullable<typeof showDiffHandler>>): void => {
    if (!showDiffHandler) throw new Error('startAgentController did not register a diff handler')
    showDiffHandler(...args)
  }
  const queueDiffs = (...args: Parameters<NonNullable<typeof queuedHandler>>): void => {
    if (!queuedHandler) throw new Error('startAgentController did not register a queue handler')
    queuedHandler(...args)
  }
  return {
    store,
    send,
    unsub,
    titleCalls,
    messageDone,
    messages,
    gitBranchChanged,
    finishedAlerts,
    showDiff,
    queueDiffs,
  }
}

test('diff events stay scoped to their owning project and thread', () => {
  const { store, showDiff, queueDiffs } = setup([thread('t1'), thread('t2')], 't1')

  queueDiffs('project-1', 't2', [{ path: 'same.ts', language: 'typescript' }])
  assert.deepEqual(store.getState().stagedDiffs, [])

  queueDiffs('project-1', 't1', [{ path: 'first.ts', language: 'typescript' }])
  assert.deepEqual(store.getState().stagedDiffs, [{ path: 'first.ts', language: 'typescript' }])

  store.setState({ activeThreadId: 't2' })
  store.emit('threads_changed')
  assert.deepEqual(store.getState().stagedDiffs, [{ path: 'same.ts', language: 'typescript' }])

  showDiff('project-1', 't1', 'same.ts', 'one', 'two', 'typescript')
  assert.equal(store.getState().activeDiff, null)

  showDiff('project-1', 't2', 'same.ts', 'before', 'after', 'typescript')
  assert.deepEqual(store.getState().activeDiff, {
    path: 'same.ts',
    before: 'before',
    after: 'after',
    language: 'typescript',
  })
})

test('opening Changes for a staged diff unhides the pane before panel sync events', () => {
  // Layout must win the race against Monaco's whenDiffHostVisible wait: emit
  // right_panel_mode_changed / files_pane_changed (and sync #pane-files) before
  // panel_changed / staged_diffs_changed, which kick the Changes viewer.
  const { store, showDiff, queueDiffs } = setup()
  const pane = document.createElement('div')
  pane.id = 'pane-files'
  pane.hidden = true
  document.body.append(pane)

  const events: string[] = []
  store.on('right_panel_mode_changed', () => {
    events.push(`mode:${pane.hidden ? 'hidden' : 'open'}`)
  })
  store.on('files_pane_changed', () => {
    events.push(`files:${pane.hidden ? 'hidden' : 'open'}`)
  })
  store.on('staged_diffs_changed', () => {
    events.push(`staged:${pane.hidden ? 'hidden' : 'open'}`)
  })
  store.on('panel_changed', () => {
    events.push(`panel:${pane.hidden ? 'hidden' : 'open'}`)
  })

  showDiff('project-1', 't1', 'a.ts', 'before', 'after', 'typescript')
  assert.equal(pane.hidden, false)
  assert.deepEqual(events, ['mode:open', 'files:open', 'panel:open'])

  events.length = 0
  queueDiffs('project-1', 't1', [{ path: 'a.ts', language: 'typescript' }])
  assert.equal(pane.hidden, false)
  assert.deepEqual(events, ['staged:open', 'panel:open'])

  pane.remove()
})

test('a queue-only diff update does not open Changes or construct an editor surface', () => {
  const { store, queueDiffs } = setup()
  store.setState({ filesPaneOpen: false, rightPanelMode: 'browser' })

  queueDiffs('project-1', 't1', [{ path: 'a.ts', language: 'typescript' }])

  assert.equal(store.getState().filesPaneOpen, false)
  assert.equal(store.getState().rightPanelMode, 'browser')
  assert.deepEqual(store.getState().stagedDiffs, [{ path: 'a.ts', language: 'typescript' }])
})

test('text chunks create one assistant message and accumulate tokens', () => {
  const { send, messages } = setup()
  send({ type: 'text', text: 'Hello' })
  send({ type: 'text', text: ' world' })

  assert.equal(messages().length, 1)
  assert.equal(at(messages(), 0).role, 'assistant')
  assert.equal(at(messages(), 0).content, 'Hello world')
})

test('assistant messages record the requested (picker) model', () => {
  const { send, messages } = setup([
    {
      ...thread('t1'),
      model: 'auto:min-intellect:40',
    },
  ])
  send({
    type: 'turn_parameters',
    model: 'openrouter:minimax/minimax-m3',
    parameters: {},
    requestedModel: 'auto:min-intellect:40',
  })
  send({ type: 'text', text: 'Hello' })
  // `model` is the concrete resolved route actually run; `requestedModel` is the
  // user's picker selection (the dynamic selector).
  assert.equal(at(messages(), 0).model, 'openrouter:minimax/minimax-m3')
  assert.equal(at(messages(), 0).requestedModel, 'auto:min-intellect:40')
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

test('tool_call_update patches ACP arguments, output, and status in place', () => {
  const { send, messages } = setup()
  send({
    type: 'tool_call',
    toolCall: { id: 'tc1', name: 'mcp.copse.run_shell', args: {}, kind: 'execute' },
  })
  send({
    type: 'tool_call_update',
    toolCallId: 'tc1',
    name: 'Run shell',
    args: { command: 'npm test' },
    status: 'running',
    result: 'starting',
    resultFormat: 'markdown',
  })

  let tc = at(at(messages(), 0).toolCalls, 0)
  assert.equal(tc.name, 'Run shell')
  assert.deepEqual(tc.args, { command: 'npm test' })
  assert.equal(tc.status, 'running')
  assert.equal(tc.result, 'starting')
  assert.equal(tc.resultFormat, 'markdown')

  send({ type: 'tool_call_update', toolCallId: 'tc1', status: 'done' })
  tc = at(at(messages(), 0).toolCalls, 0)
  assert.equal(tc.status, 'done')
  assert.equal(tc.result, 'starting')
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

test('context pressure persists the agent-reported used and window values', () => {
  const { store, send } = setup()
  send({
    type: 'context_pressure',
    contextWindow: 200_000,
    conversationBudget: 200_000,
    conversationTokens: 80_000,
    fillRatio: 0.4,
    source: 'agent-reported',
  })

  assert.deepEqual(requireThread(store, 't1').contextSnapshot, {
    contextWindow: 200_000,
    conversationBudget: 200_000,
    conversationTokens: 80_000,
    fillRatio: 0.4,
    source: 'agent-reported',
    updatedAt: requireThread(store, 't1').contextSnapshot?.updatedAt,
  })
})

test('done finalizes the message, alerts once, sets the thread idle, and resets stream state', () => {
  const { send, messages, messageDone, store, finishedAlerts } = setup()
  send({ type: 'text', text: 'answer' })
  const firstId = at(messages(), 0).id
  send({ type: 'done' })

  assert.equal(requireThread(store, 't1').status, 'idle')
  assert.deepEqual(messageDone, [firstId])
  assert.deepEqual(finishedAlerts, [{ threadId: 't1', title: 't1' }])

  // State was cleared, so a subsequent text chunk opens a fresh bubble.
  send({ type: 'text', text: 'next turn' })
  assert.equal(messages().length, 2)
  assert.equal(at(messages(), 1).content, 'next turn')
})

test('done does not alert between queued turns', () => {
  const queued = thread('t1')
  queued.pendingMessages = [
    { messageId: 'queued-user', payload: { content: 'continue' }, createdAt: 2 },
  ]
  const { send, store, finishedAlerts } = setup([queued])

  send({ type: 'done' })

  assert.equal(requireThread(store, 't1').status, 'running')
  assert.deepEqual(finishedAlerts, [])
})

test('first assistant text kicks off naming without waiting for done', async () => {
  const userMsg: Message = {
    id: 'u1',
    role: 'user',
    content: 'Add a login button',
    toolCalls: [],
    createdAt: 1,
  }
  const named = thread('t-name-on-text', [userMsg])
  named.title = 'New Thread'
  const { send, titleCalls, store } = setup([named], 't-name-on-text')

  send({ type: 'text', text: 'sure' }, 't-name-on-text')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Add a login button'])
  assert.equal(requireThread(store, 't-name-on-text').title, 'Generated Title')
})

test('first tool call kicks off naming without waiting for done', async () => {
  const userMsg: Message = {
    id: 'u1',
    role: 'user',
    content: 'List the project files',
    toolCalls: [],
    createdAt: 1,
  }
  const named = thread('t-name-on-tool', [userMsg])
  named.title = 'New Thread'
  const { send, titleCalls, store } = setup([named], 't-name-on-tool')

  send(
    {
      type: 'tool_call',
      toolCall: { id: 'tc1', name: 'list_dir', args: { path: '.' } },
    },
    't-name-on-tool',
  )
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['List the project files'])
  assert.equal(requireThread(store, 't-name-on-tool').title, 'Generated Title')
})
