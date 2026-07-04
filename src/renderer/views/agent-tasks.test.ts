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
  // Tasks are scoped to the active thread; the tests emit chunks on thread 't1'.
  store.setState({ activeThreadId: 't1' })
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

  it('echoes the command at the top of the panel, like a real terminal', () => {
    startShell(h, 'a', 'cd /repo && npm run build')
    const panel = at(panels(h), 0)
    // The (cd-stripped) command appears first, prefixed like a typed shell line.
    assert.match(panel.textContent, /^\$ npm run build\n/)
    assert.equal(panel.querySelector('.agent-task-command')?.textContent, '$ npm run build\n')
  })

  it('routes streamed output to the matching task panel by id, after the echoed command', () => {
    startShell(h, 'a', 'echo hi')
    h.emitOutput('hello\nworld\n', 'a')
    // Command line stays at the top; output follows beneath it.
    assert.match(at(panels(h), 0).textContent, /^\$ echo hi\nhello\nworld/)
  })

  it('strips ANSI escape sequences from output', () => {
    startShell(h, 'a', 'ls')
    h.emitOutput('\x1b[31mred\x1b[0m text', 'a')
    assert.equal(at(panels(h), 0).textContent, '$ ls\nred text')
  })

  it('falls back to the latest running task when output has no id', () => {
    startShell(h, 'a', 'first')
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'a', result: '', isError: false })
    startShell(h, 'b', 'second')
    h.emitOutput('streamed', null)
    assert.equal(at(panels(h), 0).textContent, '$ first\n')
    assert.equal(at(panels(h), 1).textContent, '$ second\nstreamed')
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
    assert.equal(at(panels(h), 0).textContent, '$ quiet\nfinal output')
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

  it('surfaces an external ACP agent shell command (kind: execute)', () => {
    // ACP agents run their own shells: a tool call with kind 'execute' and the
    // command in the title (its name), not the built-in run_shell tool.
    h.emitChunk('t1', {
      type: 'tool_call',
      toolCall: { id: 'e1', name: 'git status', args: {}, kind: 'execute' },
    })
    assert.equal(tabs(h).length, 1)
    assert.equal(at(tabs(h), 0).querySelector('.agent-task-label')?.textContent, 'git status')

    // Its output arrives in the tool result (ACP has no live shell-output stream).
    h.emitChunk('t1', { type: 'tool_result', toolCallId: 'e1', result: 'clean', isError: false })
    assert.equal(at(panels(h), 0).textContent, '$ git status\nclean')
  })

  it('prefers an explicit command arg over the ACP title', () => {
    h.emitChunk('t1', {
      type: 'tool_call',
      toolCall: { id: 'e2', name: 'Run shell', args: { command: 'ls -la' }, kind: 'execute' },
    })
    assert.equal(at(tabs(h), 0).querySelector('.agent-task-label')?.textContent, 'ls -la')
  })

  it('ignores non-execute ACP tool calls', () => {
    h.emitChunk('t1', {
      type: 'tool_call',
      toolCall: { id: 's1', name: 'Grep Search', args: {}, kind: 'search' },
    })
    assert.equal(tabs(h).length, 0)
  })

  it('shows only the active thread’s tasks and restores them on switch back', () => {
    startShell(h, 'a', 'thread-one cmd')
    assert.equal(tabs(h).filter((t) => !t.hidden).length, 1)

    // Switch to another thread: the first thread's task is hidden.
    h.store.setState({ activeThreadId: 't2' })
    h.store.emit('threads_changed')
    assert.equal(tabs(h).filter((t) => !t.hidden).length, 0)
    assert.equal(section(h).hidden, true)

    // A task run on the new thread shows; the old one stays hidden.
    h.emitChunk('t2', {
      type: 'tool_call',
      toolCall: { id: 'b', name: 'run_shell', args: { command: 'thread-two cmd' } },
    })
    assert.equal(tabs(h).filter((t) => !t.hidden).length, 1)

    // Switch back: the first thread's task returns, the second's hides.
    h.store.setState({ activeThreadId: 't1' })
    h.store.emit('threads_changed')
    const visible = tabs(h).filter((t) => !t.hidden)
    assert.equal(visible.length, 1)
    assert.equal(visible[0]?.querySelector('.agent-task-label')?.textContent, 'thread-one cmd')
  })
})
