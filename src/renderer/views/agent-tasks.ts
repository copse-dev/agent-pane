import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { shellCommandArg, shellCommandLabel } from '@shared/tools/tool-display.ts'
import { stripAnsiSequences } from '@shared/text/strip-ansi.ts'

// How many finished tasks to keep around before the oldest are dropped. The
// running task (and recent history) stay viewable; ancient ones are pruned so
// the list can't grow without bound across a long session.
const MAX_TASKS = 60

// Per-task output is already capped on the main side (CappedOutputAccumulator,
// COMMAND_OUTPUT_MAX_BYTES = 100KB of UTF-8 *bytes*), but guard here too in case
// a task accumulates from many streamed chunks plus a final tool result. Note the
// units differ: the main cap counts bytes, whereas this guard counts JS string
// chars, so they're not directly comparable for multi-byte content — this is a
// loose upper bound, not a mirror of the main cap.
const MAX_OUTPUT_CHARS = 200_000

type TaskStatus = 'running' | 'done' | 'error'

interface AgentTask {
  id: string
  command: string
  status: TaskStatus
  output: string
  tab: HTMLButtonElement
  panel: HTMLPreElement
}

/**
 * Renders the agent's shell commands in the Terminal tab. Each command becomes
 * an entry in an "Agent tasks" section of the left rail (alongside the shells);
 * selecting one shows its full, scrollable output as a panel on the right,
 * taking over the viewer from the live terminal until a shell tab is clicked
 * again. The running task is marked live in the list and keeps capturing output
 * even while another view is shown.
 */
export function mountAgentTasks(
  listRoot: HTMLElement,
  viewerHost: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  // Left-rail section (sits under the shells list in the same host).
  const section = el('div', { class: 'agent-tasks-section' })
  const sectionHeader = el('div', { class: 'agent-tasks-section-header' }, 'Agent tasks')
  const tabList = el('div', { class: 'agent-tasks-tablist' })
  section.append(sectionHeader, tabList)
  listRoot.append(section)

  // Viewer container — its output panels show one at a time. The parent
  // (terminals-viewer-host) gets a class that swaps the terminal body out for
  // this panel while a task is selected.
  const viewerParent = viewerHost.parentElement

  const tasks = new Map<string, AgentTask>()
  const order: string[] = []
  let selectedId: string | null = null

  function syncSectionVisibility() {
    section.hidden = tasks.size === 0
  }

  function showTaskView(show: boolean) {
    viewerParent?.classList.toggle('showing-agent-task', show)
  }

  function setStatus(task: AgentTask, status: TaskStatus) {
    task.status = status
    task.tab.dataset['status'] = status
  }

  function scrollPanelToBottom(task: AgentTask) {
    task.panel.scrollTop = task.panel.scrollHeight
  }

  function selectTask(id: string) {
    const task = tasks.get(id)
    if (!task) return
    selectedId = id
    for (const t of tasks.values()) {
      const active = t.id === id
      t.tab.classList.toggle('is-active', active)
      t.panel.hidden = !active
    }
    showTaskView(true)
    scrollPanelToBottom(task)
    // Let the shells list drop its active highlight while the task panel shows.
    store.emit('agent_task_selected', id)
  }

  function clearSelection() {
    if (selectedId === null) return
    selectedId = null
    for (const t of tasks.values()) {
      t.tab.classList.remove('is-active')
      t.panel.hidden = true
    }
    showTaskView(false)
    store.emit('agent_task_selected', null)
  }

  function prune() {
    while (order.length > MAX_TASKS) {
      const oldestId = order[0]!
      const oldest = tasks.get(oldestId)
      // Never prune a still-running or currently-viewed task.
      if (oldest && (oldest.status === 'running' || oldest.id === selectedId)) break
      order.shift()
      if (oldest) {
        oldest.tab.remove()
        oldest.panel.remove()
        tasks.delete(oldestId)
      }
    }
  }

  function addTask(id: string, rawCommand: string) {
    if (tasks.has(id)) return
    const command = shellCommandLabel(rawCommand)

    const dot = el('span', { class: 'agent-task-dot', 'aria-hidden': 'true' })
    const label = el('span', { class: 'agent-task-label', title: command }, command)
    const tab = el(
      'button',
      { type: 'button', class: 'agent-task-tab' },
      dot,
      label,
    ) as HTMLButtonElement
    const panel = el('pre', {
      class: 'agent-task-output-panel',
      'data-task-id': id,
    }) as HTMLPreElement
    panel.hidden = true

    const task: AgentTask = { id, command, status: 'running', output: '', tab, panel }
    tab.addEventListener('click', () => selectTask(id))

    setStatus(task, 'running')
    tasks.set(id, task)
    order.push(id)
    tabList.append(tab)
    viewerHost.append(panel)
    prune()
    syncSectionVisibility()
  }

  function appendOutput(id: string | null, data: string) {
    const task = id ? tasks.get(id) : latestRunningTask()
    if (!task) return
    const clean = stripAnsiSequences(data)
    if (!clean) return
    const showing = task.id === selectedId
    const atBottom = task.panel.scrollHeight - task.panel.scrollTop - task.panel.clientHeight < 16
    task.output += clean
    if (task.output.length > MAX_OUTPUT_CHARS) {
      task.output = task.output.slice(task.output.length - MAX_OUTPUT_CHARS)
      task.panel.textContent = task.output
    } else {
      task.panel.append(document.createTextNode(clean))
    }
    if (showing && atBottom) scrollPanelToBottom(task)
  }

  function completeTask(id: string, result: string, isError: boolean) {
    const task = tasks.get(id)
    if (!task) return
    setStatus(task, isError ? 'error' : 'done')
    // If nothing streamed (e.g. a fast command, or output we didn't capture
    // live), fall back to the final tool result so the panel isn't empty.
    if (!task.output.trim() && result.trim()) {
      task.output = stripAnsiSequences(result)
      task.panel.textContent = task.output
    }
    if (task.id === selectedId) scrollPanelToBottom(task)
  }

  function latestRunningTask(): AgentTask | null {
    for (let i = order.length - 1; i >= 0; i--) {
      const task = tasks.get(order[i]!)
      if (task && task.status === 'running') return task
    }
    return null
  }

  function clearAll() {
    clearSelection()
    for (const task of tasks.values()) {
      task.tab.remove()
      task.panel.remove()
    }
    tasks.clear()
    order.length = 0
    syncSectionVisibility()
  }

  syncSectionVisibility()

  const unsubChunk = api.agent.onChunk((_threadId, chunk) => {
    if (chunk.type === 'tool_call' && chunk.toolCall.name === 'run_shell') {
      const command = shellCommandArg(chunk.toolCall.args)
      if (command) addTask(chunk.toolCall.id, command)
    } else if (chunk.type === 'tool_result' && tasks.has(chunk.toolCallId)) {
      completeTask(chunk.toolCallId, chunk.result, chunk.isError)
    }
  })

  const unsubOutput = api.agent.onShellOutput((data, toolCallId) => {
    appendOutput(toolCallId, data)
  })

  // A shell tab took over the viewer — yield the task panel back to it.
  const unsubShell = store.on('shell_tab_activated', clearSelection)
  const unsubWorkspace = store.on('workspace_changed', clearAll)

  return () => {
    unsubChunk()
    unsubOutput()
    unsubShell()
    unsubWorkspace()
    showTaskView(false)
    section.remove()
  }
}
