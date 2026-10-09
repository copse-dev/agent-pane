import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread, ToolCall, TurnOutcome } from '@shared/types'
import {
  conciseActivityLabel,
  conciseTurnSummaries,
  hasLaterAssistantInTurn,
  isConciseCollapsedMessage,
  isConciseMessage,
  isConciseThread,
  isConciseThreadModel,
  isConciseWorkingMessage,
  liveTurnStartId,
  syncConciseMessageClasses,
  turnStartId,
} from './concise-thread.ts'

// Opus 5.5 sits well above the gate; Haiku 4.5 and gpt-4o well below it.
const CAPABLE = 'claude-opus-5-5'
const MODEST = 'claude-haiku-4-5'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Done.',
    toolCalls: [],
    createdAt: 0,
    ...overrides,
  }
}

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    name: 'read_file',
    args: { path: 'a.ts' },
    status: 'done',
    result: '',
    ...overrides,
  }
}

function failedOutcome(): TurnOutcome {
  return {
    status: 'failed',
    stopReason: 'error',
    source: 'provider',
    executor: 'local',
    provider: 'anthropic',
    model: CAPABLE,
    endedAt: 0,
  }
}

function thread(
  overrides: Partial<Thread> = {},
): Pick<Thread, 'status' | 'messages' | 'todos' | 'model'> {
  return { status: 'running', messages: [], ...overrides }
}

describe('concise thread model gate', () => {
  it('admits only models scoring above 50 on the canonical scale', () => {
    assert.equal(isConciseThreadModel(CAPABLE), true)
    assert.equal(isConciseThreadModel(`anthropic:${CAPABLE}`), true)
    assert.equal(isConciseThreadModel(MODEST), false)
    assert.equal(isConciseThreadModel('gpt-4o'), false)
  })

  it('keeps the full view for unsourced or missing models', () => {
    assert.equal(isConciseThreadModel('mock'), false)
    assert.equal(isConciseThreadModel(undefined), false)
  })

  it('decides per assistant message from the route that ran it', () => {
    assert.equal(isConciseMessage(message({ model: CAPABLE })), true)
    assert.equal(isConciseMessage(message({ model: MODEST, requestedModel: CAPABLE })), false)
    assert.equal(isConciseMessage(message({ requestedModel: CAPABLE })), true)
    assert.equal(isConciseMessage(message({ role: 'user', model: CAPABLE })), false)
  })

  it('treats a concise bubble with a running tool as working', () => {
    const working = message({ model: CAPABLE, toolCalls: [tool()] })
    assert.equal(
      isConciseWorkingMessage({ ...working, toolCalls: [tool({ status: 'running' })] }),
      true,
    )
    assert.equal(isConciseWorkingMessage(working), false)
    assert.equal(isConciseWorkingMessage(message({ model: CAPABLE })), false)
    assert.equal(isConciseWorkingMessage({ ...working, turnOutcome: failedOutcome() }), false)
    assert.equal(isConciseWorkingMessage(message({ model: MODEST, toolCalls: [tool()] })), false)
  })

  it('toggles the stylesheet classes on the bubble', () => {
    const el = document.createElement('div')
    const running = message({ model: CAPABLE, toolCalls: [tool({ status: 'running' })] })
    syncConciseMessageClasses(el, running, true)
    assert.deepEqual([...el.classList], ['msg-concise', 'msg-concise-working', 'msg-concise-steps'])
    syncConciseMessageClasses(el, message({ model: CAPABLE, toolCalls: [tool()] }), true)
    assert.deepEqual([...el.classList], ['msg-concise', 'msg-concise-steps'])
    syncConciseMessageClasses(el, message({ model: CAPABLE }), true)
    assert.deepEqual([...el.classList], ['msg-concise'])
    syncConciseMessageClasses(el, message({ model: MODEST }), true)
    assert.deepEqual([...el.classList], [])
  })

  it('keeps every bubble in full while the experimental setting is off', () => {
    const el = document.createElement('div')
    syncConciseMessageClasses(el, message({ model: CAPABLE, toolCalls: [tool()] }), true)
    syncConciseMessageClasses(el, message({ model: CAPABLE, toolCalls: [tool()] }), false)
    assert.deepEqual([...el.classList], [])
  })

  it('follows the newest assistant message, then the thread model', () => {
    assert.equal(isConciseThread(thread({ model: CAPABLE })), true)
    assert.equal(
      isConciseThread(
        thread({
          model: CAPABLE,
          messages: [message({ model: CAPABLE }), message({ id: 'm2', model: MODEST })],
        }),
      ),
      false,
    )
  })
})

describe('concise activity label', () => {
  it('names the running item rather than the generic tool verb', () => {
    const running = (tc: ToolCall): string | null =>
      conciseActivityLabel(thread({ messages: [message({ toolCalls: [tool(), tc] })] }))
    assert.equal(
      running(
        tool({
          id: 't2',
          name: 'run_shell',
          args: { command: 'cd /repo && pnpm test' },
          status: 'running',
        }),
      ),
      'Running pnpm test…',
    )
    assert.equal(
      running(
        tool({ id: 't2', name: 'write_file', args: { path: 'src/app.ts' }, status: 'running' }),
      ),
      'Editing src/app.ts…',
    )
  })

  it('leaves the ordinary label in charge when nothing is running', () => {
    assert.equal(
      conciseActivityLabel(thread({ messages: [message({ toolCalls: [tool()] })] })),
      null,
    )
    assert.equal(
      conciseActivityLabel(
        thread({
          status: 'idle',
          messages: [message({ toolCalls: [tool({ status: 'running' })] })],
        }),
      ),
      null,
    )
  })

  it('carries todo progress like the ordinary label', () => {
    const label = conciseActivityLabel(
      thread({
        messages: [
          message({
            toolCalls: [tool({ name: 'run_shell', args: { command: 'ls' }, status: 'running' })],
          }),
        ],
        todos: [
          { id: '1', content: 'a', status: 'completed' },
          { id: '2', content: 'b', status: 'in_progress' },
        ],
      }),
    )
    assert.match(label ?? '', /^Running ls… \(.+\)$/)
  })
})

describe('turn identity', () => {
  const messages = [
    message({ id: 'a0', role: 'assistant' }),
    message({ id: 'u1', role: 'user' }),
    message({ id: 'a1', role: 'assistant' }),
    message({ id: 'a2', role: 'assistant' }),
    message({ id: 'u2', role: 'user' }),
    message({ id: 'a3', role: 'assistant' }),
  ]

  it('names the prompt that started a message’s turn', () => {
    assert.equal(turnStartId(messages, 'a1'), 'u1')
    assert.equal(turnStartId(messages, 'a2'), 'u1')
    assert.equal(turnStartId(messages, 'u2'), 'u2')
    assert.equal(turnStartId(messages, 'a3'), 'u2')
  })

  it('has no turn before the first prompt or for an unknown message', () => {
    assert.equal(turnStartId(messages, 'a0'), null)
    assert.equal(turnStartId(messages, 'missing'), null)
  })

  it('finds the live turn from the newest prompt', () => {
    assert.equal(liveTurnStartId(messages), 'u2')
    assert.equal(liveTurnStartId([]), null)
  })
})

describe('concise turn summaries', () => {
  const prompt = (id: string, overrides: Partial<Message> = {}): Message =>
    message({ id, role: 'user', content: 'Do it', ...overrides })
  const reply = (id: string, overrides: Partial<Message> = {}): Message =>
    message({ id, model: CAPABLE, ...overrides })
  const stopped = (overrides: Partial<TurnOutcome> = {}): TurnOutcome => ({
    ...failedOutcome(),
    status: 'cancelled',
    source: 'user',
    ...overrides,
  })

  it('counts only what the view hides: not below-gate bubbles, not offer cards', () => {
    const edit = { additions: 7, deletions: 3 }
    const [summary] = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', { toolCalls: [tool({ id: 't1', editStats: edit })] }),
      reply('a2', { model: MODEST, toolCalls: [tool({ id: 't2', editStats: edit })] }),
      reply('a3', {
        toolCalls: [tool({ id: 't3', name: 'propose_thread', editStats: edit })],
      }),
    ])
    assert.equal(summary?.toolCallCount, 1)
    assert.deepEqual(summary.edits, edit)
  })

  it('lists a concise turn that hid tool calls, with the whole turn’s calls', () => {
    const summaries = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', { toolCalls: [tool({ id: 't1' }), tool({ id: 't2' })] }),
      reply('a2', { toolCalls: [tool({ id: 't3' })] }),
    ])
    assert.deepEqual(summaries, [
      {
        startId: 'u1',
        messageIds: ['u1', 'a1', 'a2'],
        toolCallCount: 3,
        edits: null,
        hasHiddenSteps: true,
        interruption: null,
      },
    ])
  })

  it('skips turns that hide nothing, from models below the gate, or before any prompt', () => {
    assert.deepEqual(
      conciseTurnSummaries([
        message({ id: 'a0', model: CAPABLE, toolCalls: [tool()] }),
        prompt('u1'),
        reply('a1'),
        prompt('u2'),
        message({ id: 'a2', model: MODEST, toolCalls: [tool()] }),
      ]),
      [],
    )
  })

  it('totals the lines the turn’s edits changed, across its bubbles', () => {
    const [summary] = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', {
        toolCalls: [tool({ editStats: { additions: 4, deletions: 2 } }), tool({ id: 't2' })],
      }),
      reply('a2', { toolCalls: [tool({ id: 't3', editStats: { additions: 1, deletions: 0 } })] }),
    ])
    assert.deepEqual(summary?.edits, { additions: 5, deletions: 2 })
  })

  it('counts reasoning as a hidden step', () => {
    const [summary] = conciseTurnSummaries([prompt('u1'), reply('a1', { reasoning: 'Hmm.' })])
    assert.equal(summary?.hasHiddenSteps, true)
    assert.equal(summary.toolCallCount, 0)
  })

  it('keys each turn by its own prompt and judges the model per message', () => {
    const summaries = conciseTurnSummaries([
      prompt('u1'),
      message({ id: 'a1', model: MODEST, toolCalls: [tool()] }),
      prompt('u2'),
      reply('a2', { toolCalls: [tool()] }),
    ])
    assert.deepEqual(
      summaries.map((turn) => turn.startId),
      ['u2'],
    )
  })

  it('lists a stopped turn even when it did no work, naming who stopped it', () => {
    assert.deepEqual(
      conciseTurnSummaries([prompt('u1'), reply('a1', { turnOutcome: stopped() })]),
      [
        {
          startId: 'u1',
          messageIds: ['u1', 'a1'],
          toolCallCount: 0,
          edits: null,
          hasHiddenSteps: false,
          interruption: 'user',
        },
      ],
    )
    const [sentNew] = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', { toolCalls: [tool()], turnOutcome: stopped({ userAbort: 'send_now' }) }),
      prompt('u2'),
    ])
    assert.equal(sentNew?.interruption, 'message')
  })

  it('does not call a failed or host-cancelled turn a user interruption', () => {
    const [failed] = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', { toolCalls: [tool()], turnOutcome: failedOutcome() }),
    ])
    assert.equal(failed?.interruption, null)
    const [host] = conciseTurnSummaries([
      prompt('u1'),
      reply('a1', { toolCalls: [tool()], turnOutcome: stopped({ source: 'host' }) }),
    ])
    assert.equal(host?.interruption, null)
  })
})

describe('collapsed concise bubbles', () => {
  const steps = message({ id: 'a1', model: CAPABLE, toolCalls: [tool()] })
  const summary = message({ id: 'a2', model: CAPABLE })

  it('collapses a process-only bubble once a later assistant bubble exists', () => {
    assert.equal(isConciseCollapsedMessage([steps, summary], 0, true), true)
    assert.equal(isConciseCollapsedMessage([steps, summary], 1, true), false)
  })

  it('keeps a bubble that carries a thread proposal or reviewer-input card', () => {
    for (const name of ['propose_thread', 'request_review_input']) {
      const offer = message({ id: 'a1', model: CAPABLE, toolCalls: [tool({ name })] })
      assert.equal(isConciseCollapsedMessage([offer, summary], 0, true), false, name)
    }
  })

  it('stops looking for a later bubble at the next user prompt', () => {
    const earlier = message({ id: 'a1', model: CAPABLE, toolCalls: [tool()] })
    const nextPrompt = message({ id: 'u2', role: 'user', content: 'Again' })
    const nextReply = message({ id: 'a2', model: CAPABLE })
    const thread = [earlier, nextPrompt, nextReply]
    assert.equal(hasLaterAssistantInTurn(thread, 0), false)
    assert.equal(isConciseCollapsedMessage(thread, 0, true), false)
    assert.equal(hasLaterAssistantInTurn([earlier, nextReply], 0), true)
  })

  it('keeps the turn’s last bubble even when it has tool calls, until a later one arrives', () => {
    assert.equal(isConciseCollapsedMessage([steps], 0, true), false)
  })

  it('collapses a bubble with a tool running, since its text is narration', () => {
    const running = message({ model: CAPABLE, toolCalls: [tool({ status: 'running' })] })
    assert.equal(isConciseCollapsedMessage([running], 0, true), true)
  })

  it('keeps a bubble that produced a screenshot, and a failed turn’s text', () => {
    const shot = message({
      model: CAPABLE,
      toolCalls: [
        tool({
          images: [{ dataUrl: 'data:image/png;base64,AA', name: 's.png', kind: 'screenshot' }],
        }),
      ],
    })
    assert.equal(isConciseCollapsedMessage([shot, summary], 0, true), false)
    const failed = message({ model: CAPABLE, toolCalls: [tool()], turnOutcome: failedOutcome() })
    assert.equal(isConciseCollapsedMessage([failed, summary], 0, true), false)
  })

  it('collapses nothing with the view off or for a model below the gate', () => {
    assert.equal(isConciseCollapsedMessage([steps, summary], 0, false), false)
    const modest = message({ model: MODEST, toolCalls: [tool()] })
    assert.equal(isConciseCollapsedMessage([modest, summary], 0, true), false)
  })
})
