import type { AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { getActiveThread, patchThreadAnywhere } from '@shared/store/thread-helpers.ts'
import { el } from '../dom/helpers.ts'
import { createOverlayDialog } from './dialog-shell.ts'

/** Thread choice; Copse managed is the absence of an override. */
export function mountAgentExecutionModeControl(
  store: AppStore,
  isAgentSelected: () => boolean,
  onChange: () => void,
): {
  element: HTMLElement
  menuLabel: () => string
  open: () => void
  refresh: () => void
  destroy: () => void
} {
  const badge = el(
    'span',
    { class: 'agent-execution-mode-badge', role: 'status', hidden: '' },
    'Agent managed',
  )
  const shell = createOverlayDialog({
    id: 'agent-execution-mode-dialog',
    className: 'agent-execution-mode-dialog',
  })
  const title = el('h2', { id: 'agent-execution-mode-title' }, 'Execution mode')
  const description = el('p', {}, 'Choose how the selected agent acts in this thread.')
  const copse = el(
    'button',
    { type: 'button', class: 'agent-execution-mode-option', 'data-mode': 'copse' },
    el('strong', {}, 'Copse managed'),
    el('span', {}, 'Use Copse action approvals and its sandbox where available.'),
  )
  const agent = el(
    'button',
    { type: 'button', class: 'agent-execution-mode-option', 'data-mode': 'agent' },
    el('strong', {}, 'Agent managed'),
    el('span', {}, 'Use the agent’s own tools, safety checks, and approval decisions.'),
  )
  const note = el(
    'p',
    { class: 'agent-execution-mode-note' },
    'Agent managed runs the selected agent without Copse’s process sandbox. Copse shows the activity the agent reports. Copse tools still use their own permissions. The change applies to the next turn.',
  )
  const cancel = el('button', { type: 'button' }, 'Cancel')
  const apply = el(
    'button',
    { type: 'button', class: 'agent-execution-mode-apply' },
    'Apply to thread',
  )
  shell.dialog.setAttribute('aria-labelledby', title.id)
  shell.dialog.append(
    title,
    description,
    el('div', { class: 'agent-execution-mode-options' }, copse, agent),
    note,
    el('div', { class: 'agent-execution-mode-actions' }, cancel, apply),
  )
  let selected: 'copse' | 'agent' = 'copse'

  function activeThread(): Thread | undefined {
    return getActiveThread(store)
  }

  function refresh(): void {
    const thread = activeThread()
    badge.hidden = !thread || thread.executionMode !== 'agent' || !isAgentSelected()
  }

  function renderSelection(): void {
    copse.setAttribute('aria-pressed', String(selected === 'copse'))
    agent.setAttribute('aria-pressed', String(selected === 'agent'))
    apply.disabled = selected === (activeThread()?.executionMode === 'agent' ? 'agent' : 'copse')
  }

  function open(): void {
    if (!activeThread() || !isAgentSelected()) return
    selected = activeThread()?.executionMode === 'agent' ? 'agent' : 'copse'
    renderSelection()
    shell.open()
  }

  copse.addEventListener('click', () => {
    selected = 'copse'
    renderSelection()
  })
  agent.addEventListener('click', () => {
    selected = 'agent'
    renderSelection()
  })
  cancel.addEventListener('click', shell.close)
  apply.addEventListener('click', () => {
    const thread = activeThread()
    if (!thread) return
    patchThreadAnywhere(store, thread.id, (current) => {
      const { executionMode: _previous, ...rest } = current
      return selected === 'agent'
        ? { ...rest, executionMode: 'agent', updatedAt: Date.now() }
        : { ...rest, updatedAt: Date.now() }
    })
    store.emit('threads_changed')
    shell.close()
    refresh()
    onChange()
  })
  refresh()

  return {
    element: badge,
    menuLabel: () => 'Execution mode…',
    open,
    refresh,
    destroy: (): void => {
      shell.dialog.remove()
    },
  }
}
