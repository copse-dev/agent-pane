import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { StreamChunk } from '@shared/types'
import { mountAgentTasks } from './agent-tasks.ts'

type ChunkHandler = (threadId: string, chunk: StreamChunk) => void
type OutputHandler = (data: string, toolCallId: string | null) => void

interface Harness {
  host: HTMLElement
  emitChunk: ChunkHandler
  emitOutput: OutputHandler
  dispose: () => void
}

function mount(): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const store = createStore()
  let chunkHandler: ChunkHandler = () => {}
  let outputHandler: OutputHandler = () => {}
  const api = {
    agent: {
      onChunk: (h: ChunkHandler) => {
        chunkHandler = h
        return () => {}
      },
      onShellOutput: (h: OutputHandler) => {
        outputHandler = h
        return () => {}
      },
    },
  } as unknown as ApiClient
  const dispose = mountAgentTasks(host, store, api)
  return {
    host,
    emitChunk: (tid, chunk) => chunkHandler(tid, chunk),
    emitOutput: (data, id) => outputHandler(data, id),
    dispose,
  }
}

function startShell(h: Harness, id: string, command: string): void {
  h.emitChunk('t1', { type: 'tool_call', toolCall: { id, name: 'run_shell', args: { command } } })
}

function rows(h: Harness): HTMLElement[] {
  return [...h.host.querySelectorAll<HTMLElement>('.agent-task')]
}

describe('agent-tasks', () => {
  let h: Harness
  beforeEach(() => {
    document.body.innerHTML = ''
    h = mount()
  })

  it('is hidden until the agent runs a shell command', () => {
    assert.equal(h.host.hidden, true)
    startShell(h, 'a', 'npm test')
    assert.equal(h.host.hidden, false)
    assert.equal(rows(h).length, 1)
  })

  it('shows the command label and starts running + expanded', () => {
    startShell(h, 'a', 'cd /repo && npm run build')
    const row = rows(h)[0]!
    assert.equal(row.dataset['status'], 'running')
    assert.equal(row.classList.contains('is-expanded'), true)
    // cd-prefix is stripped from the displayed command.
    assert.equal(row.querySelector('.agent-task-cmd')!.textContent, 'npm run build')
  })

  it('routes streamed output to the matching task by id', () => {
    startShell(h, 'a', 'echo hi')
    h.emitOutput('hello\nworld\n', 'a')
    assert.match(rows(h)[0]!.querySelector('.agent-task-output')!.textContent!, /hello\nworld/)
  })

  it('strips ANSI escape sequences from output', () => {
    startShell(h, 'a', 'ls')
    h.emitOutput('\x1b[31mred\x1b[0m text', 'a')
    assert.equal(rows(h)[0]!.querySelector('.agent-task-output')!.textContent, 'red text')
  })

  it('falls back to the latest running task when output has no id', () => {
    startShell(h, 'a', 'first')
    // Empty result so completeTask doesn't backfill task "a" with output.
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'a', result: '', isError: false })
    startShell(h, 'b', 'second')
    h.emitOutput('streamed', null)
    assert.equal(rows(h)[0]!.querySelector('.agent-task-output')!.textContent, '')
    assert.equal(rows(h)[1]!.querySelector('.agent-task-output')!.textContent, 'streamed')
  })

  it('marks a task done/error on tool_result', () => {
    startShell(h, 'a', 'ok')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'a', result: 'fine', isError: false })
    assert.equal(rows(h)[0]!.dataset['status'], 'done')

    startShell(h, 'b', 'boom')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'b', result: 'nope', isError: true })
    assert.equal(rows(h)[1]!.dataset['status'], 'error')
  })

  it('uses the tool result as output when nothing streamed', () => {
    startShell(h, 'a', 'quiet')
    h.emitChunk('t1', {
      type: 'tool_result',
      toolCallId: 'a',
      result: 'final output',
      isError: false,
    })
    assert.equal(rows(h)[0]!.querySelector('.agent-task-output')!.textContent, 'final output')
  })

  it('collapses earlier tasks when a new command starts', () => {
    startShell(h, 'a', 'one')
    assert.equal(rows(h)[0]!.classList.contains('is-expanded'), true)
    startShell(h, 'b', 'two')
    assert.equal(rows(h)[0]!.classList.contains('is-expanded'), false)
    assert.equal(rows(h)[1]!.classList.contains('is-expanded'), true)
  })

  it('toggles a task open/closed when its header is clicked', () => {
    startShell(h, 'a', 'one')
    startShell(h, 'b', 'two')
    const first = rows(h)[0]!
    const header = first.querySelector<HTMLButtonElement>('.agent-task-header')!
    assert.equal(first.classList.contains('is-expanded'), false)
    header.click()
    assert.equal(first.classList.contains('is-expanded'), true)
    header.click()
    assert.equal(first.classList.contains('is-expanded'), false)
  })

  it('ignores non-shell tool calls', () => {
    h.emitChunk('t1', { type: 'tool_call', toolCall: { id: 'x', name: 'read_file', args: {} } })
    assert.equal(rows(h).length, 0)
    assert.equal(h.host.hidden, true)
  })
})
