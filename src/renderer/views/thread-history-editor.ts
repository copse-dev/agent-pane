import type { AppStore } from '@shared/store/store.ts'
import type { ThreadHistorySnapshot } from '@shared/threads/history-edit.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el, clear } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import { awaitPendingThreadPersistence } from '../controller/persistence.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { showErrorToast, showToast } from './toast.ts'

interface OpenHistoryEditorOptions {
  projectId: string
  threadId: string
  focusMessageId?: string
}

function replaceThread(
  store: AppStore,
  projectId: string,
  thread: Awaited<ReturnType<ApiClient['threads']['editHistory']>>['thread'],
): void {
  const state = store.getState()
  if (state.activeProjectId !== projectId) return
  if (!state.threads.some((candidate) => candidate.id === thread.id)) return
  store.setState({
    threads: state.threads.map((candidate) =>
      candidate.id === thread.id ? { ...thread, messagesLoaded: true } : candidate,
    ),
  })
  store.emit('threads_changed')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open the same-thread transcript editor reached through the Fork actions. */
export function openThreadHistoryEditor(
  store: AppStore,
  api: ApiClient,
  options: OpenHistoryEditorOptions,
): void {
  document.querySelector<HTMLDialogElement>('#thread-history-editor')?.close()

  const overlay = createOverlayDialog({
    id: 'thread-history-editor',
    className: 'history-editor-overlay',
  })
  const title = el('h2', { class: 'history-editor-title' }, 'Edit thread history')
  const subtitle = el(
    'p',
    { class: 'history-editor-subtitle' },
    'Revise what Copse and the model remember from this thread.',
  )
  const close = el(
    'button',
    {
      class: 'ui-btn ui-btn-ghost history-editor-close',
      type: 'button',
      'aria-label': 'Close history editor',
    },
    closeIcon('ui-icon'),
  )
  const body = el('div', { class: 'history-editor-body' })
  const footer = el('div', { class: 'history-editor-footer' })
  const shell = el(
    'section',
    { class: 'history-editor-shell', 'aria-labelledby': 'history-editor-heading' },
    el('header', { class: 'history-editor-header' }, el('div', {}, title, subtitle), close),
    body,
    footer,
  )
  title.id = 'history-editor-heading'
  overlay.dialog.append(shell)

  const closeEditor = (): void => {
    overlay.close()
  }
  close.addEventListener('click', closeEditor)
  overlay.dialog.addEventListener(
    'close',
    () => {
      overlay.dialog.remove()
    },
    { once: true },
  )
  overlay.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeEditor()
  })

  const renderLoading = (): void => {
    clear(body)
    clear(footer)
    body.append(el('div', { class: 'history-editor-loading' }, 'Loading thread history…'))
  }

  const renderEditor = (source: ThreadHistorySnapshot): void => {
    let revision = source.revision
    const drafts = source.messages.map((message) => ({ ...message }))
    let saving = false

    const summary = el('span', { class: 'history-editor-summary' })
    const apply = el('button', { class: 'ui-btn ui-btn-primary', type: 'button' }, 'Apply changes')
    const cancel = el('button', { class: 'ui-btn ui-btn-secondary', type: 'button' }, 'Cancel')
    const undo = el(
      'button',
      { class: 'ui-btn ui-btn-secondary history-editor-undo', type: 'button' },
      'Undo last edit',
    )
    undo.hidden = !source.canUndo
    cancel.addEventListener('click', closeEditor)

    const updateControls = (): void => {
      const included = drafts.filter((message) => message.included).length
      const changed = drafts.some((message, index) => {
        const original = source.messages[index]
        return original?.content !== message.content || !message.included
      })
      const retainsUnrecoverableContext = drafts.some(
        (message) => message.included && message.reconstructionWarning !== undefined,
      )
      summary.textContent = `${String(included)} of ${String(drafts.length)} messages kept`
      apply.disabled = saving || !changed || included === 0 || retainsUnrecoverableContext
      undo.disabled = saving
      cancel.disabled = saving
    }

    const list = el('div', { class: 'history-editor-list' })
    for (const draft of drafts) {
      const included = el('input', {
        class: 'history-editor-include',
        type: 'checkbox',
        'aria-label': `Include ${draft.role} message`,
      })
      included.checked = draft.included
      const role = el(
        'span',
        { class: `history-editor-role history-editor-role-${draft.role}` },
        draft.role === 'user' ? 'You' : draft.role === 'assistant' ? 'Copse' : 'Error',
      )
      const textarea = el('textarea', {
        class: 'history-editor-message-input',
        rows: String(Math.min(8, Math.max(2, draft.content.split('\n').length))),
        spellcheck: 'true',
        'aria-label': `Edit ${draft.role} message`,
      })
      textarea.value = draft.content
      const row = el(
        'article',
        {
          class: 'history-editor-message',
          'data-message-id': draft.id,
        },
        el(
          'div',
          { class: 'history-editor-message-head' },
          el('label', { class: 'history-editor-toggle' }, included, role, 'Include'),
          ...(draft.reconstructionWarning
            ? [
                el(
                  'span',
                  { class: 'history-editor-tool-note history-editor-message-warning' },
                  'Exclude this message to reconstruct safely',
                ),
              ]
            : draft.hasToolCalls
              ? [
                  el(
                    'span',
                    { class: 'history-editor-tool-note' },
                    'Tool activity stays with this message',
                  ),
                ]
              : []),
        ),
        textarea,
      )
      const syncIncluded = (): void => {
        draft.included = included.checked
        textarea.disabled = !draft.included
        row.classList.toggle('is-excluded', !draft.included)
        updateControls()
      }
      included.addEventListener('change', syncIncluded)
      textarea.addEventListener('input', () => {
        draft.content = textarea.value
        updateControls()
      })
      syncIncluded()
      list.append(row)
    }

    clear(body)
    if (source.blockedReason) {
      body.append(
        el(
          'div',
          { class: 'history-editor-warning', role: 'alert' },
          el('strong', {}, 'Some message context cannot be reconstructed.'),
          el('span', {}, `${source.blockedReason} Exclude the marked message to continue.`),
        ),
      )
    } else {
      body.append(
        el(
          'div',
          { class: 'history-editor-notice' },
          'Applying replaces this thread’s visible transcript and future model context. Tool calls remain attached to included messages.',
        ),
      )
    }
    body.append(list)

    clear(footer)
    footer.append(summary, el('div', { class: 'history-editor-actions' }, undo, cancel, apply))
    updateControls()

    const applyChanges = async (): Promise<void> => {
      if (apply.disabled) return
      saving = true
      apply.textContent = 'Applying…'
      updateControls()
      try {
        const result = await api.threads.editHistory(options.projectId, options.threadId, {
          expectedRevision: revision,
          messages: drafts.map(({ id, content, included }) => ({ id, content, included })),
        })
        replaceThread(store, options.projectId, result.thread)
        revision = result.revision
        showToast('Thread history updated')
        renderEditor({
          revision: result.revision,
          title: result.thread.title,
          messages: result.thread.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            included: true,
            hasToolCalls: message.toolCalls.length > 0,
          })),
          canUndo: result.canUndo,
        })
      } catch (error) {
        saving = false
        apply.textContent = 'Apply changes'
        updateControls()
        showErrorToast('Could not update thread history', error)
      }
    }
    apply.addEventListener('click', () => {
      void applyChanges()
    })

    const undoChanges = async (): Promise<void> => {
      saving = true
      undo.textContent = 'Undoing…'
      updateControls()
      try {
        const result = await api.threads.undoHistoryEdit(
          options.projectId,
          options.threadId,
          revision,
        )
        replaceThread(store, options.projectId, result.thread)
        showToast('History edit undone')
        renderEditor({
          revision: result.revision,
          title: result.thread.title,
          messages: result.thread.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            included: true,
            hasToolCalls: message.toolCalls.length > 0,
          })),
          canUndo: false,
        })
      } catch (error) {
        saving = false
        undo.textContent = 'Undo last edit'
        updateControls()
        showErrorToast('Could not undo history edit', errorText(error))
      }
    }
    undo.addEventListener('click', () => {
      void undoChanges()
    })

    if (options.focusMessageId) {
      requestAnimationFrame(() => {
        const focused = list.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(options.focusMessageId ?? '')}"]`,
        )
        focused?.classList.add('is-focused')
        focused?.scrollIntoView({ block: 'center' })
        focused?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
      })
    }
  }

  renderLoading()
  overlay.open()
  void awaitPendingThreadPersistence()
    .then(() => api.threads.historySnapshot(options.projectId, options.threadId))
    .then(renderEditor)
    .catch((error: unknown) => {
      clear(body)
      clear(footer)
      body.append(
        el(
          'div',
          { class: 'history-editor-load-error', role: 'alert' },
          'Could not load this thread’s history.',
          el('span', {}, errorText(error)),
        ),
      )
      footer.append(el('button', { class: 'ui-btn ui-btn-secondary', type: 'button' }, 'Close'))
      footer.querySelector('button')?.addEventListener('click', closeEditor)
    })
}
