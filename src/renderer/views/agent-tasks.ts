import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { shellCommandLabel } from '@shared/tools/tool-display.ts'

// How many finished tasks to keep around before the oldest are dropped. The
// running task (and recent history) stay scrollable; ancient ones are pruned so
// the list can't grow without bound across a long session.
const MAX_TASKS = 60

// Per-task output is already capped to ~100KB on the main side
// (CappedOutputAccumulator), but guard here too in case a task accumulates from
// many streamed chunks plus a final tool result.
const MAX_OUTPUT_CHARS = 200_000

// Strip ANSI/VT control sequences for display. Mirrors
// `stripTerminalControlSequences` in src/main/services/subprocess-output-cap.ts
// (anchored on ESC so literal `[..m` text survives); kept inline to avoid
// importing a main-process module into the renderer bundle.
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

type TaskStatus = 'running' | 'done' | 'error'

interface AgentTask {
  id: string
  command: string
  status: TaskStatus
  output: string
  expanded: boolean
  row: HTMLElement
  header: HTMLButtonElement
  statusDot: HTMLElement
  outputEl: HTMLPreElement
}

function shellCommandFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const command = (args as Record<string, unknown>)['command']
  return typeof command === 'string' && command.trim() ? command : null
}

/**
 * Renders the live "Agent tasks" list shown in the Terminal tab: one collapsible
 * card per shell command the agent runs, with its streamed output. The running
 * task is expanded; when a new command starts the previous ones collapse but
 * remain in the list so their full output can be re-opened and scrolled.
 */
export function mountAgentTasks(host: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const header = el('div', { class: 'agent-tasks-header' }, 'Agent tasks')
  const list = el('div', { class: 'agent-tasks-list' })
  host.append(header, list)

  const tasks = new Map<string, AgentTask>()
  // Insertion order, oldest first — drives pruning and the "latest running" fallback.
  const order: string[] = []

  function syncHostVisibility() {
    host.hidden = tasks.size === 0
  }

  function collapseAll() {
    for (const task of tasks.values()) setExpanded(task, false)
  }

  function setExpanded(task: AgentTask, expanded: boolean) {
    task.expanded = expanded
    task.row.classList.toggle('is-expanded', expanded)
    task.outputEl.hidden = !expanded
    task.header.setAttribute('aria-expanded', String(expanded))
    if (expanded) scrollOutputToBottom(task)
  }

  function scrollOutputToBottom(task: AgentTask) {
    task.outputEl.scrollTop = task.outputEl.scrollHeight
  }

  function setStatus(task: AgentTask, status: TaskStatus) {
    task.status = status
    task.row.dataset['status'] = status
  }

  function prune() {
    while (order.length > MAX_TASKS) {
      const oldestId = order[0]!
      const oldest = tasks.get(oldestId)
      // Never prune a still-running task.
      if (oldest && oldest.status === 'running') break
      order.shift()
      if (oldest) {
        oldest.row.remove()
        tasks.delete(oldestId)
      }
    }
  }

  function addTask(id: string, rawCommand: string) {
    if (tasks.has(id)) return
    // A new command is starting — collapse everything else so the list stays
    // focused on what's currently running.
    collapseAll()

    const command = shellCommandLabel(rawCommand)
    const statusDot = el('span', { class: 'agent-task-status', 'aria-hidden': 'true' })
    const cmd = el('span', { class: 'agent-task-cmd', title: command }, command)
    const chevron = el('span', { class: 'agent-task-chevron', 'aria-hidden': 'true' })
    const headerBtn = el(
      'button',
      { type: 'button', class: 'agent-task-header', 'aria-expanded': 'true' },
      statusDot,
      cmd,
      chevron,
    ) as HTMLButtonElement
    const outputEl = el('pre', { class: 'agent-task-output' }) as HTMLPreElement
    const row = el('div', { class: 'agent-task', 'data-task-id': id }, headerBtn, outputEl)

    const task: AgentTask = {
      id,
      command,
      status: 'running',
      output: '',
      expanded: true,
      row,
      header: headerBtn,
      statusDot,
      outputEl,
    }
    headerBtn.addEventListener('click', () => setExpanded(task, !task.expanded))

    setStatus(task, 'running')
    setExpanded(task, true)
    tasks.set(id, task)
    order.push(id)
    list.append(row)
    prune()
    syncHostVisibility()
  }

  function appendOutput(id: string | null, data: string) {
    const task = id ? tasks.get(id) : latestRunningTask()
    if (!task) return
    const clean = stripAnsi(data)
    if (!clean) return
    const atBottom =
      task.outputEl.scrollHeight - task.outputEl.scrollTop - task.outputEl.clientHeight < 16
    task.output += clean
    if (task.output.length > MAX_OUTPUT_CHARS) {
      task.output = task.output.slice(task.output.length - MAX_OUTPUT_CHARS)
      task.outputEl.textContent = task.output
    } else {
      task.outputEl.append(document.createTextNode(clean))
    }
    if (task.expanded && atBottom) scrollOutputToBottom(task)
  }

  function completeTask(id: string, result: string, isError: boolean) {
    const task = tasks.get(id)
    if (!task) return
    setStatus(task, isError ? 'error' : 'done')
    // If nothing streamed (e.g. a fast command, or output we didn't capture
    // live), fall back to the final tool result so the card isn't empty.
    if (!task.output.trim() && result.trim()) {
      task.output = stripAnsi(result)
      task.outputEl.textContent = task.output
    }
    if (task.expanded) scrollOutputToBottom(task)
  }

  function latestRunningTask(): AgentTask | null {
    for (let i = order.length - 1; i >= 0; i--) {
      const task = tasks.get(order[i]!)
      if (task && task.status === 'running') return task
    }
    return null
  }

  function clearAll() {
    for (const task of tasks.values()) task.row.remove()
    tasks.clear()
    order.length = 0
    syncHostVisibility()
  }

  syncHostVisibility()

  const unsubChunk = api.agent.onChunk((_threadId, chunk) => {
    if (chunk.type === 'tool_call' && chunk.toolCall.name === 'run_shell') {
      const command = shellCommandFromArgs(chunk.toolCall.args)
      if (command) addTask(chunk.toolCall.id, command)
    } else if (chunk.type === 'tool_result' && tasks.has(chunk.toolCallId)) {
      completeTask(chunk.toolCallId, chunk.result, chunk.isError)
    }
  })

  const unsubOutput = api.agent.onShellOutput((data, toolCallId) => {
    appendOutput(toolCallId, data)
  })

  const unsubWorkspace = store.on('workspace_changed', clearAll)

  return () => {
    unsubChunk()
    unsubOutput()
    unsubWorkspace()
  }
}
