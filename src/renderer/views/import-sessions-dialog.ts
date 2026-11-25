import type { AppStore } from '@shared/store/store.ts'
import {
  getThreadById,
  sortThreadsNewestFirst,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import type { ExternalSessionSummary, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { clear, el } from '../dom/helpers.ts'
import { lazyBodyDialog } from './dialog-shell.ts'
import { externalSessionSourceLabel } from './imported-session-notice.ts'
import { relativeDate } from './mention-picker.ts'
import { showErrorToast, showToast } from './toast.ts'

const ensureDialog = lazyBodyDialog('import-sessions-dialog', 'import-sessions-dialog')

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/** Add threads main just created to the open project, newest first, and open `focusId`. */
function adoptImportedThreads(store: AppStore, imported: Thread[], focusId: string | null): void {
  const known = new Set(store.getState().threads.map((thread) => thread.id))
  const fresh = imported.filter((thread) => !known.has(thread.id))
  if (fresh.length > 0) {
    store.setState({ threads: sortThreadsNewestFirst([...fresh, ...store.getState().threads]) })
    store.emit('threads_changed')
  }
  if (focusId && getThreadById(store, focusId)) switchThread(store, focusId)
}

function sessionRow(
  session: ExternalSessionSummary,
  selected: Set<string>,
  onChange: () => void,
  onOpen: (threadId: string) => void,
): HTMLElement {
  const meta = [
    session.relativeCwd ? session.relativeCwd : null,
    session.gitBranch ?? null,
    relativeDate(session.updatedAt),
  ].filter((part): part is string => part !== null)
  const source = el(
    'span',
    { class: 'import-session-source', 'data-source': session.source },
    externalSessionSourceLabel(session.source),
  )
  const text = el(
    'span',
    { class: 'import-session-text' },
    el('span', { class: 'import-session-title' }, session.title),
    el('span', { class: 'import-session-meta' }, source, ...meta.flatMap((part) => [' · ', part])),
  )
  const importedThreadId = session.importedThreadId
  if (importedThreadId) {
    const open = el('button', { type: 'button', class: 'ui-btn import-session-open' }, 'Open')
    open.addEventListener('click', () => {
      onOpen(importedThreadId)
    })
    return el(
      'li',
      { class: 'import-session-row is-imported', 'data-key': session.key },
      text,
      el('span', { class: 'import-session-imported' }, 'Imported'),
      open,
    )
  }
  const checkbox = el('input', {
    type: 'checkbox',
    class: 'import-session-check',
    'aria-label': `Import “${session.title}”`,
  })
  checkbox.checked = selected.has(session.key)
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(session.key)
    else selected.delete(session.key)
    onChange()
  })
  return el(
    'li',
    { class: 'import-session-row', 'data-key': session.key },
    el('label', { class: 'import-session-label' }, checkbox, text),
  )
}

/**
 * "Import sessions…": list the Claude Code and Codex CLI sessions that ran in
 * the active project's folder and turn the chosen ones into threads. Expects
 * the project to be active already; its threads are the ones in the store.
 */
export function openImportSessionsDialog(
  store: AppStore,
  api: ApiClient,
  project: { id: string; name: string },
): void {
  const dialog = ensureDialog()
  clear(dialog)
  const perOpen = new AbortController()
  const body = el(
    'div',
    { class: 'import-sessions-body', role: 'status' },
    el('p', { class: 'field-hint' }, 'Looking for sessions…'),
  )
  const importBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary import-sessions-confirm', disabled: true },
    'Import',
  )
  const cancelBtn = el('button', { type: 'button', class: 'ui-btn' }, 'Cancel')
  dialog.append(
    el('h3', {}, 'Import sessions'),
    el(
      'p',
      { class: 'field-hint' },
      `Claude Code and Codex sessions that ran in ${project.name}. Each one becomes a thread you can continue here.`,
    ),
    body,
    el('div', { class: 'import-sessions-actions' }, cancelBtn, importBtn),
  )

  const selected = new Set<string>()
  const close = (): void => {
    perOpen.abort()
    dialog.close()
  }
  dialog.addEventListener(
    'close',
    () => {
      perOpen.abort()
    },
    { signal: perOpen.signal },
  )
  cancelBtn.addEventListener('click', close)
  const openThread = (threadId: string): void => {
    close()
    if (getThreadById(store, threadId)) switchThread(store, threadId)
  }
  const syncButton = (): void => {
    importBtn.disabled = selected.size === 0
    importBtn.textContent =
      selected.size === 0 ? 'Import' : `Import ${plural(selected.size, 'session', 'sessions')}`
  }

  importBtn.addEventListener('click', () => {
    const keys = [...selected]
    if (keys.length === 0) return
    importBtn.disabled = true
    importBtn.textContent = 'Importing…'
    void api.threads
      .importExternalSessions(project.id, keys)
      .then((result) => {
        if (perOpen.signal.aborted || store.getState().activeProjectId !== project.id) return
        const focus = result.imported[0]?.id ?? result.alreadyImported[0]?.threadId ?? null
        adoptImportedThreads(store, result.imported, focus)
        close()
        const parts = [`Imported ${plural(result.imported.length, 'session', 'sessions')}`]
        if (result.failed.length > 0)
          parts.push(`${plural(result.failed.length, 'session', 'sessions')} could not be read`)
        showToast(`${parts.join('. ')}.`, result.failed.length > 0 ? { variant: 'error' } : {})
      })
      .catch((error: unknown) => {
        showErrorToast('Could not import sessions', error)
        syncButton()
      })
  })

  void api.threads
    .listExternalSessions(project.id)
    .then(({ sessions, sourcesFound }) => {
      if (perOpen.signal.aborted) return
      body.removeAttribute('role')
      if (sessions.length === 0) {
        body.replaceChildren(
          el(
            'p',
            { class: 'import-sessions-empty' },
            sourcesFound.length === 0
              ? 'No Claude Code or Codex sessions were found on this computer.'
              : `No Claude Code or Codex sessions ran in ${project.name}’s folder.`,
          ),
        )
        return
      }
      body.replaceChildren(
        el(
          'ul',
          { class: 'import-sessions-list', 'aria-label': 'Sessions' },
          ...sessions.map((session) => sessionRow(session, selected, syncButton, openThread)),
        ),
      )
      syncButton()
    })
    .catch((error: unknown) => {
      if (perOpen.signal.aborted) return
      body.replaceChildren(
        el('p', { class: 'import-sessions-empty' }, 'Could not look for sessions.'),
      )
      showErrorToast('Could not look for sessions', error)
    })

  dialog.showModal()
  cancelBtn.focus()
}
