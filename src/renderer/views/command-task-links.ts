// Links between a `run_background` command's card, its task's output, and the
// completion wake that task later started (#3956). The card shows the task id
// from the moment it runs; these let the user read that task's output from the
// card and get back to the card from the wake.
import type { ToolCall } from '@shared/types'
import { el } from '../dom/helpers.ts'

export interface BackgroundTaskLogs {
  logs: string
  running: boolean
}

/** Reads one task's retained output for the conversation's active thread. */
export type BackgroundTaskLogLoader = (taskId: string) => Promise<BackgroundTaskLogs | null>

let loadLogs: BackgroundTaskLogLoader | null = null

/** Installed by the conversation view while it is mounted. */
export function setBackgroundTaskLogLoader(next: BackgroundTaskLogLoader | null): void {
  loadLogs = next
}

/**
 * The card body's "Task output" section, for a command running (or that ran)
 * as a background task. Output is read on request, never on render: it lives
 * in main's memory only while the app runs, and a transcript can hold many.
 */
export function createBackgroundTaskLogsSection(tc: ToolCall): HTMLElement | null {
  const taskId = tc.commandPhase?.backgroundTaskId
  if (taskId === undefined) return null
  const button = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact tool-task-logs-button' },
    'Show logs',
  )
  // Not `.tool-result`: that names the call's own result, which specs and
  // card code find by class. The task's output only shares its look.
  const output = el('div', { class: 'tool-task-logs-output', hidden: true })
  const section = el(
    'div',
    { class: 'tool-task-logs', 'data-background-task-id': taskId },
    el(
      'div',
      { class: 'tool-task-logs-header' },
      el('span', { class: 'acp-content-label' }, 'Task output'),
      button,
    ),
    output,
  )
  button.addEventListener('click', () => {
    const loader = loadLogs
    if (!loader) return
    button.disabled = true
    void loader(taskId)
      .then((result) => {
        output.replaceChildren(logsContent(result))
      })
      .catch(() => {
        output.replaceChildren(
          el('p', { class: 'tool-result-empty' }, "Couldn't read this task's output."),
        )
      })
      .finally(() => {
        output.hidden = false
        button.disabled = false
        button.textContent = 'Refresh logs'
      })
  })
  return section
}

function logsContent(result: BackgroundTaskLogs | null): HTMLElement {
  if (!result) {
    return el(
      'p',
      { class: 'tool-result-empty' },
      'This task’s output is no longer available. It was stopped, or Copse restarted.',
    )
  }
  const text = result.logs.trim()
  if (text === '') {
    return el('p', { class: 'tool-result-empty' }, result.running ? 'No output yet.' : 'No output.')
  }
  return el('pre', {}, text)
}

/**
 * The command call that started background task `taskId`, newest first. A
 * completion wake's operation id is that task id, so this is the card the wake
 * reports on.
 */
export function backgroundTaskCommandCall(
  thread: { messages: readonly { toolCalls: readonly ToolCall[] }[] } | undefined,
  taskId: string,
): ToolCall | undefined {
  if (!thread) return undefined
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const call = thread.messages[index]?.toolCalls.find(
      (candidate) => candidate.commandPhase?.backgroundTaskId === taskId,
    )
    if (call) return call
  }
  return undefined
}

const REVEAL_FLASH_MS = 1600

/**
 * Open every disclosure around a tool card, scroll it into view and flash it
 * briefly. Returns false when the card is not in `root` (for instance a
 * transcript that has not rendered that far back).
 */
export function revealToolCard(root: ParentNode, toolCallId: string): boolean {
  const card = Array.from(root.querySelectorAll<HTMLElement>('[data-tool-id]')).find(
    (candidate) => candidate.getAttribute('data-tool-id') === toolCallId,
  )
  if (!card) return false
  for (let node = card.parentElement; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true
  }
  card.scrollIntoView({ block: 'center' })
  card.classList.add('tool-card-revealed')
  setTimeout(() => {
    card.classList.remove('tool-card-revealed')
  }, REVEAL_FLASH_MS)
  return true
}
