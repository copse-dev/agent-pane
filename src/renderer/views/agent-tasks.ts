import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { shellCommandLabel } from '@shared/tools/tool-display.ts'
import { at } from '@shared/array-utils.ts'
import { isTabVisibleForProject } from './project-scoped-tabs.ts'

// How many finished tasks to keep around before the oldest are dropped. The
// running task (and recent history) stay viewable; ancient ones are pruned so
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
  /** Project this run belongs to; only the active project's runs are shown. */
  projectId: string | null
  command: string
  status: TaskStatus
  output: string
  tab: HTMLButtonElement
  panel: HTMLPreElement
}

function shellCommandFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const command = (args as Record<string, unknown>)['command']
  return typeof command === 'string' && command.trim() ? command : null
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

  function currentProjectId(): string | null {
    return store.getState().activeProjectId
  }

  function visibleTaskCount(): number {
    let count = 0
    for (const task of tasks.values()) {
      if (isTabVisibleForProject(task, currentProjectId())) count++
    }
    return count
  }

  function syncSectionVisibility(): void {
    section.hidden = visibleTaskCount() === 0
  }

  function showTaskView(show: boolean): void {
    viewerParent?.classList.toggle('showing-agent-task', show)
  }

  function setStatus(task: AgentTask, status: TaskStatus): void {
    task.status = status
    task.tab.dataset['status'] = status
  }

  function scrollPanelToBottom(task: AgentTask): void {
    task.panel.scrollTop = task.panel.scrollHeight
  }

  function selectTask(id: string): void {
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

  function clearSelection(): void {
    if (selectedId === null) return
    selectedId = null
    for (const t of tasks.values()) {
      t.tab.classList.remove('is-active')
      t.panel.hidden = true
    }
    showTaskView(false)
    store.emit('agent_task_selected', null)
  }

  function prune(): void {
    while (order.length > MAX_TASKS) {
      const oldestId = at(order, 0)
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

  function addTask(id: string, rawCommand: string): void {
    if (tasks.has(id)) return
    const command = shellCommandLabel(rawCommand)

    const dot = el('span', { class: 'agent-task-dot', 'aria-hidden': 'true' })
    const label = el('span', { class: 'agent-task-label', title: command }, command)
    const tab = el('button', { type: 'button', class: 'agent-task-tab' }, dot, label)
    const panel = el('pre', {
      class: 'agent-task-output-panel',
      'data-task-id': id,
    })
    panel.hidden = true

    const task: AgentTask = {
      id,
      projectId: currentProjectId(),
      command,
      status: 'running',
      output: '',
      tab,
      panel,
    }
    tab.addEventListener('click', () => {
      selectTask(id)
    })

    setStatus(task, 'running')
    tasks.set(id, task)
    order.push(id)
    tabList.append(tab)
    viewerHost.append(panel)
    if (!isTabVisibleForProject(task, currentProjectId())) tab.hidden = true
    prune()
    syncSectionVisibility()
  }

  function appendOutput(id: string | null, data: string): void {
    const task = id ? tasks.get(id) : latestRunningTask()
    if (!task) return
    const clean = stripAnsi(data)
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

  function completeTask(id: string, result: string, isError: boolean): void {
    const task = tasks.get(id)
    if (!task) return
    setStatus(task, isError ? 'error' : 'done')
    // If nothing streamed (e.g. a fast command, or output we didn't capture
    // live), fall back to the final tool result so the panel isn't empty.
    if (!task.output.trim() && result.trim()) {
      task.output = stripAnsi(result)
      task.panel.textContent = task.output
    }
    if (task.id === selectedId) scrollPanelToBottom(task)
  }

  function latestRunningTask(): AgentTask | null {
    for (let i = order.length - 1; i >= 0; i--) {
      const task = tasks.get(at(order, i))
      if (task && task.status === 'running') return task
    }
    return null
  }

  // Project switch: keep each project's agent runs but only show the active
  // project's (issue #502 part c). Switching back restores the prior runs rather
  // than resetting them.
  function onProjectSwitch(): void {
    const active = currentProjectId()
    for (const task of tasks.values()) {
      const visible = isTabVisibleForProject(task, active)
      task.tab.hidden = !visible
      if (!visible) task.panel.hidden = true
    }
    const selected = selectedId ? tasks.get(selectedId) : null
    if (selected && !isTabVisibleForProject(selected, active)) clearSelection()
    syncSectionVisibility()
  }

  syncSectionVisibility()

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

  // A shell tab took over the viewer — yield the task panel back to it.
  const unsubShell = store.on('shell_tab_activated', clearSelection)
  const unsubWorkspace = store.on('workspace_changed', onProjectSwitch)

  return () => {
    unsubChunk()
    unsubOutput()
    unsubShell()
    unsubWorkspace()
    showTaskView(false)
    section.remove()
  }
}
