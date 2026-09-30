import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread, ToolCall, TurnOutcome } from '@shared/types'
import {
  conciseActivityLabel,
  isConciseMessage,
  isConciseThread,
  isConciseThreadModel,
  isConciseWorkingMessage,
  syncConciseMessageClasses,
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
    assert.deepEqual([...el.classList], ['msg-concise', 'msg-concise-working'])
    syncConciseMessageClasses(el, message({ model: CAPABLE, toolCalls: [tool()] }), true)
    assert.deepEqual([...el.classList], ['msg-concise'])
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
