import { el, clear, qsRequired } from '../dom/helpers.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// A roadmap item is one `Roadmap`-typed knowledge note. Derive the shapes from
// the IPC surface so this view never imports main-process types directly.
type RoadmapItem = Awaited<ReturnType<ApiClient['roadmap']['list']>>[number]
type RoadmapStatus = Parameters<ApiClient['roadmap']['update']>[3]

// The lifecycle the roadmap_plan tool maintains; the IPC layer re-validates, so
// a drifted entry here fails loudly rather than corrupting a note.
const STATUS_OPTIONS: readonly RoadmapStatus[] = [
  'ready',
  'blocked',
  'conflicts',
  'done',
  'archived',
]

function roadmapModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'roadmap'
}

function itemNotes(item: RoadmapItem): string {
  return item.fields['notes'] ?? ''
}

function itemStatus(item: RoadmapItem): RoadmapStatus {
  return (STATUS_OPTIONS as readonly string[]).includes(item.status ?? '')
    ? (item.status as RoadmapStatus)
    : 'ready'
}

/**
 * The Roadmap pane (issue #556; #645 Phase 3 — surfacing). A sidebar backlog of
 * the project's `roadmap_plan` notes — future-work prompts — plus an inline
 * editor to jot new prompts and update each item's prompt, notes, and lifecycle
 * status. Mirrors the Memories pane over the same knowledge store and reuses its
 * `memories-*` layout primitives.
 */
export function mountRoadmapPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  let items: RoadmapItem[] = []
  // The item being edited, or null. `creating` distinguishes a blank new-item
  // form (selectedId null, form shown) from the no-selection empty state.
  let selectedId: string | null = null
  let creating = false
  let loadToken = 0

  // --- list column ----------------------------------------------------------
  const listHeader = el('div', { class: 'git-changes-header' })
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Roadmap'),
    panePopoutButton(api, 'roadmap', 'roadmap'),
    el(
      'button',
      {
        type: 'button',
        class: 'git-changes-refresh-btn memories-new-btn roadmap-new-btn',
        'aria-label': 'New roadmap item',
        title: 'New roadmap item',
      },
      '+',
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'git-changes-refresh-btn roadmap-refresh-btn',
        'aria-label': 'Refresh roadmap',
        title: 'Refresh',
      },
      '↻',
    ),
  )
  const newBtn = qsRequired<HTMLButtonElement>(listHeader, '.roadmap-new-btn')
  const refreshBtn = qsRequired<HTMLButtonElement>(listHeader, '.roadmap-refresh-btn')
  const listBody = el('div', { class: 'git-changes-list roadmap-list' })
  listRoot.append(listHeader, listBody)

  // --- editor column --------------------------------------------------------
  const emptyState = el(
    'div',
    { class: 'panel-empty memories-empty roadmap-empty' },
    'Select a roadmap item, or jot a prompt to run later with +',
  )

  const form = el('form', { class: 'memories-form roadmap-form', hidden: true })
  const promptInput = el('textarea', {
    class: 'memories-field memories-body-input roadmap-prompt-input',
    placeholder: 'Prompt or idea to run later…',
    'aria-label': 'Roadmap prompt',
  })
  const notesInput = el('input', {
    type: 'text',
    class: 'memories-field roadmap-notes-input',
    placeholder: 'Notes (e.g. blocked on PR #123)',
    'aria-label': 'Roadmap notes',
  })
  const statusSelect = el('select', {
    class: 'memories-field roadmap-status-select',
    'aria-label': 'Roadmap status',
  })
  for (const status of STATUS_OPTIONS) {
    statusSelect.append(el('option', { value: status }, status))
  }
  // New items always start `ready`; the status control only applies to items
  // that already exist (matching the roadmap_plan tool's add/set_status split).
  const statusLabel = el('label', { class: 'memories-label' }, 'Status')
  const metaLine = el('div', { class: 'memories-meta' })
  const errorLine = el('div', { class: 'memories-error', hidden: true })

  const saveBtn = el(
    'button',
    { type: 'submit', class: 'memories-btn memories-btn-primary roadmap-save-btn' },
    'Save',
  )
  // Runs the jotted prompt: opens a fresh thread with the composer pre-filled
  // (not auto-sent — the user reviews, tweaks, and hits send). Hidden in
  // pop-out windows, where there is no chat pane to land in (popout.css).
  const startBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-start-btn',
      title: 'Open a new thread with this prompt in the composer',
    },
    'Start thread',
  )
  const deleteBtn = el(
    'button',
    { type: 'button', class: 'memories-btn memories-btn-danger roadmap-delete-btn' },
    'Delete',
  )
  const cancelBtn = el(
    'button',
    { type: 'button', class: 'memories-btn roadmap-cancel-btn' },
    'Cancel',
  )
  const actions = el('div', { class: 'memories-actions' }, saveBtn, startBtn, deleteBtn, cancelBtn)

  form.append(
    el('label', { class: 'memories-label' }, 'Prompt'),
    promptInput,
    el('label', { class: 'memories-label' }, 'Notes'),
    notesInput,
    statusLabel,
    statusSelect,
    metaLine,
    errorLine,
    actions,
  )
  viewerRoot.append(emptyState, form)

  function showError(message: string): void {
    errorLine.textContent = message
    errorLine.hidden = false
  }

  /** True when the visible form holds edits not yet reflected in the stored item. */
  function isEditorDirty(item: RoadmapItem | null | undefined): boolean {
    return (
      promptInput.value !== (item?.body ?? '') ||
      notesInput.value !== (item ? itemNotes(item) : '') ||
      (item != null && statusSelect.value !== itemStatus(item))
    )
  }

  // `preserveDirty` is set by background refreshes (store events) so an in-progress
  // edit or new-item draft is not silently overwritten with the persisted values.
  // Explicit navigation (selecting an item, New, Cancel) passes it unset to load fresh.
  function renderEditor(opts?: { preserveDirty?: boolean }): void {
    errorLine.hidden = true
    const item = selectedId ? items.find((m) => m.id === selectedId) : null
    const editing = !form.hidden
    const dirty = editing && (creating || isEditorDirty(item))
    if (!item && !creating) {
      // Keep an in-progress draft visible rather than collapsing to the empty
      // state when a refresh fires while the user is typing.
      if (opts?.preserveDirty && dirty) return
      form.hidden = true
      emptyState.hidden = false
      return
    }
    emptyState.hidden = true
    form.hidden = false
    if (!(opts?.preserveDirty && dirty)) {
      promptInput.value = item?.body ?? ''
      notesInput.value = item ? itemNotes(item) : ''
      statusSelect.value = item ? itemStatus(item) : 'ready'
    }
    statusLabel.hidden = !item
    statusSelect.hidden = !item
    startBtn.hidden = !item
    deleteBtn.hidden = !item
    if (item?.updatedAt) {
      metaLine.hidden = false
      metaLine.textContent = `Updated ${item.updatedAt}`
    } else {
      metaLine.hidden = true
      metaLine.textContent = ''
    }
  }

  function renderList(): void {
    clear(listBody)
    if (items.length === 0) {
      listBody.append(
        el(
          'div',
          { class: 'git-changes-empty roadmap-list-empty' },
          'No roadmap items yet. Jot a prompt to run later with +, or the agent records them with the roadmap_plan tool.',
        ),
      )
      return
    }
    for (const item of items) {
      const isSelected = item.id === selectedId
      const status = itemStatus(item)
      const row = el('button', {
        type: 'button',
        class: `git-change-row memories-row roadmap-row${isSelected ? ' is-selected' : ''}`,
      })
      const main = el('div', { class: 'memories-row-main' })
      main.append(
        el('span', { class: 'memories-row-title roadmap-row-title' }, item.title || '(untitled)'),
        el('span', { class: `roadmap-status-badge is-${status}` }, status),
      )
      row.append(main)
      row.addEventListener('click', () => {
        selectedId = item.id
        creating = false
        renderList()
        renderEditor()
      })
      listBody.append(row)
    }
  }

  // `preserveDirty` is passed only by background store-event refreshes so an
  // in-progress edit/draft is not clobbered. Explicit actions (save, delete,
  // workspace change) refresh without it so the editor renders fresh.
  async function refresh(opts?: { preserveDirty?: boolean }): Promise<void> {
    const token = ++loadToken
    let next: RoadmapItem[]
    try {
      next = await api.roadmap.list()
    } catch {
      next = []
    }
    if (token !== loadToken) return
    items = next
    // Drop a selection whose item vanished (deleted elsewhere), but keep an
    // in-progress new-item form open.
    if (selectedId && !items.some((m) => m.id === selectedId) && !creating) {
      selectedId = null
    }
    renderList()
    renderEditor(opts)
  }

  function startNew(): void {
    selectedId = null
    creating = true
    renderList()
    renderEditor()
    promptInput.focus()
  }

  async function save(): Promise<void> {
    const prompt = promptInput.value.trim()
    const notes = notesInput.value.trim()
    if (!prompt) {
      showError('Add a prompt before saving.')
      return
    }
    saveBtn.disabled = true
    try {
      if (creating || !selectedId) {
        const created = await api.roadmap.create(prompt, notes || undefined)
        selectedId = created.id
        creating = false
      } else {
        const updated = await api.roadmap.update(
          selectedId,
          prompt,
          notes || undefined,
          statusSelect.value as RoadmapStatus,
        )
        if (!updated) {
          showError('This roadmap item no longer exists.')
          selectedId = null
          creating = false
        }
      }
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not save roadmap item.')
    } finally {
      saveBtn.disabled = false
    }
  }

  async function remove(): Promise<void> {
    if (!selectedId) return
    const item = items.find((m) => m.id === selectedId)
    if (!confirm(`Delete roadmap item "${item?.title || 'untitled'}"?`)) return
    deleteBtn.disabled = true
    try {
      await api.roadmap.delete(selectedId)
      selectedId = null
      creating = false
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not delete roadmap item.')
    } finally {
      deleteBtn.disabled = false
    }
  }

  function cancel(): void {
    creating = false
    selectedId = null
    renderList()
    renderEditor()
  }

  // Open a fresh thread pre-filled with the item's prompt (plus its notes as a
  // trailing context line). Uses the editor's *current* text so an unsaved
  // tweak goes to the thread the user is looking at, not a stale stored copy.
  function startThread(): void {
    const prompt = promptInput.value.trim()
    if (!prompt) {
      showError('Add a prompt before starting a thread.')
      return
    }
    const notes = notesInput.value.trim()
    const draft = notes ? `${prompt}\n\nNotes: ${notes}` : prompt
    // Persist whatever is in the chat composer to its thread before switching.
    store.emit('composer_draft_flush')
    createThread(store, draft)
    getPromptAttachmentHandlers()?.focusComposer?.()
  }

  newBtn.addEventListener('click', startNew)
  refreshBtn.addEventListener('click', () => void refresh())
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void save()
  })
  startBtn.addEventListener('click', startThread)
  deleteBtn.addEventListener('click', () => void remove())
  cancelBtn.addEventListener('click', cancel)

  const unsubs = [
    store.on('right_panel_mode_changed', () => {
      if (roadmapModeActive(store)) void refresh({ preserveDirty: true })
    }),
    store.on('files_pane_changed', () => {
      if (roadmapModeActive(store)) void refresh({ preserveDirty: true })
    }),
    store.on('workspace_changed', () => {
      // The roadmap is per-project; drop the previous workspace's selection.
      selectedId = null
      creating = false
      items = []
      if (roadmapModeActive(store)) void refresh()
      else {
        renderList()
        renderEditor()
      }
    }),
  ]

  renderList()
  renderEditor()
  // If the roadmap is already the active pane on mount (pop-out window or
  // restored layout), the *_changed events that normally trigger the first load
  // fired before this pane existed — so catch up here.
  if (roadmapModeActive(store)) void refresh()

  return () => {
    unsubs.forEach((u) => {
      u()
    })
  }
}
