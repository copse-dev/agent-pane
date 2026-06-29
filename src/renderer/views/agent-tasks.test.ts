import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { StreamChunk } from '@shared/types'
import { el } from '../dom/helpers.ts'
import { at } from '@shared/array-utils.ts'
import { mountAgentTasks } from './agent-tasks.ts'

type ChunkHandler = (threadId: string, chunk: StreamChunk) => void
type OutputHandler = (data: string, toolCallId: string | null) => void

interface Harness {
  listRoot: HTMLElement
  viewerParent: HTMLElement
  viewerHost: HTMLElement
  store: AppStore
  emitChunk: ChunkHandler
  emitOutput: OutputHandler
  dispose: () => void
}

function mount(): Harness {
  const listRoot = el('div', { class: 'terminals-list-host' })
  const viewerParent = el('div', { class: 'terminals-viewer-host' })
  const viewerHost = el('div', { class: 'agent-tasks-host' })
  viewerParent.append(viewerHost)
  document.body.append(listRoot, viewerParent)
  const store = createStore()
  let chunkHandler: ChunkHandler = () => {}
  let outputHandler: OutputHandler = () => {}
  const api = {
    agent: {
      onChunk: (h: ChunkHandler): (() => void) => {
        chunkHandler = h
        return () => {}
      },
      onShellOutput: (h: OutputHandler): (() => void) => {
        outputHandler = h
        return () => {}
      },
    },
  } as unknown as ApiClient
  const dispose = mountAgentTasks(listRoot, viewerHost, store, api)
  return {
    listRoot,
    viewerParent,
    viewerHost,
    store,
    emitChunk: (tid, chunk): void => {
      chunkHandler(tid, chunk)
    },
    emitOutput: (data, id): void => {
      outputHandler(data, id)
    },
    dispose,
  }
}

function startShell(h: Harness, id: string, command: string): void {
  h.emitChunk('t1', { type: 'tool_call', toolCall: { id, name: 'run_shell', args: { command } } })
}

function tabs(h: Harness): HTMLButtonElement[] {
  return [...h.listRoot.querySelectorAll<HTMLButtonElement>('.agent-task-tab')]
}

function panels(h: Harness): HTMLElement[] {
  return [...h.viewerHost.querySelectorAll<HTMLElement>('.agent-task-output-panel')]
}

function section(h: Harness): HTMLElement {
  const el = h.listRoot.querySelector<HTMLElement>('.agent-tasks-section')
  if (!el) throw new Error('missing .agent-tasks-section')
  return el
}

describe('agent-tasks', () => {
  let h: Harness
  beforeEach(() => {
    document.body.innerHTML = ''
    h = mount()
  })

  it('keeps the left section hidden until the agent runs a shell command', () => {
    assert.equal(section(h).hidden, true)
    startShell(h, 'a', 'npm test')
    assert.equal(section(h).hidden, false)
    assert.equal(tabs(h).length, 1)
    assert.equal(panels(h).length, 1)
  })

  it('shows the stripped command label and a running status on the tab', () => {
    startShell(h, 'a', 'cd /repo && npm run build')
    const tab = at(tabs(h), 0)
    assert.equal(tab.dataset['status'], 'running')
    assert.equal(tab.querySelector('.agent-task-label')?.textContent, 'npm run build')
  })

  it('routes streamed output to the matching task panel by id', () => {
    startShell(h, 'a', 'echo hi')
    h.emitOutput('hello\nworld\n', 'a')
    assert.match(at(panels(h), 0).textContent, /hello\nworld/)
  })

  it('strips ANSI escape sequences from output', () => {
    startShell(h, 'a', 'ls')
    h.emitOutput('\x1b[31mred\x1b[0m text', 'a')
    assert.equal(at(panels(h), 0).textContent, 'red text')
  })

  it('falls back to the latest running task when output has no id', () => {
    startShell(h, 'a', 'first')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'a', result: '', isError: false })
    startShell(h, 'b', 'second')
    h.emitOutput('streamed', null)
    assert.equal(at(panels(h), 0).textContent, '')
    assert.equal(at(panels(h), 1).textContent, 'streamed')
  })

  it('marks a task done/error on tool_result', () => {
    startShell(h, 'a', 'ok')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'a', result: 'fine', isError: false })
    assert.equal(at(tabs(h), 0).dataset['status'], 'done')

    startShell(h, 'b', 'boom')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'b', result: 'nope', isError: true })
    assert.equal(at(tabs(h), 1).dataset['status'], 'error')
  })

  it('uses the tool result as output when nothing streamed', () => {
    startShell(h, 'a', 'quiet')
    h.emitChunk('t1', {
      type: 'tool_result',
      toolCallId: 'a',
      result: 'final output',
      isError: false,
    })
    assert.equal(at(panels(h), 0).textContent, 'final output')
  })

  it('shows the task panel and takes over the viewer when a tab is clicked', () => {
    startShell(h, 'a', 'one')
    startShell(h, 'b', 'two')
    // Nothing selected yet — viewer still belongs to the terminal.
    assert.equal(h.viewerParent.classList.contains('showing-agent-task'), false)
    assert.equal(at(panels(h), 0).hidden, true)

    let selected: string | null | undefined
    h.store.on('agent_task_selected', (id) => (selected = id))
    at(tabs(h), 0).click()

    assert.equal(h.viewerParent.classList.contains('showing-agent-task'), true)
    assert.equal(at(tabs(h), 0).classList.contains('is-active'), true)
    assert.equal(at(panels(h), 0).hidden, false)
    assert.equal(at(panels(h), 1).hidden, true)
    assert.equal(selected, 'a')
  })

  it('yields the viewer back to the terminal on shell_tab_activated', () => {
    startShell(h, 'a', 'one')
    at(tabs(h), 0).click()
    assert.equal(h.viewerParent.classList.contains('showing-agent-task'), true)

    let cleared = false
    h.store.on('agent_task_selected', (id) => {
      if (id === null) cleared = true
    })
    h.store.emit('shell_tab_activated')

    assert.equal(h.viewerParent.classList.contains('showing-agent-task'), false)
    assert.equal(at(tabs(h), 0).classList.contains('is-active'), false)
    assert.equal(at(panels(h), 0).hidden, true)
    assert.equal(cleared, true)
  })

  it('ignores non-shell tool calls', () => {
    h.emitChunk('t1', { type: 'tool_call', toolCall: { id: 'x', name: 'read_file', args: {} } })
    assert.equal(tabs(h).length, 0)
    assert.equal(section(h).hidden, true)
  })
})
