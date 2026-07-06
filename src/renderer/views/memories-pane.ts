import { el, clear, qsRequired } from '../dom/helpers.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// A memory is one `Memory`-typed knowledge note. Derive the shape from the IPC
// surface so this view never imports main-process types directly.
type Memory = Awaited<ReturnType<ApiClient['memories']['list']>>[number]

function memoriesModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'memories'
}

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * The Memories pane (issue #645, Phase 3 — surfacing). A sidebar list of the
 * project's `remember`/`recall` OKF notes plus an inline editor to add, edit,
 * and delete them — the first user-facing surface over the knowledge store.
 */
export function mountMemoriesPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  let memories: Memory[] = []
  // The note being edited, or null. `creating` distinguishes a blank new-note
  // form (selectedId null, form shown) from the no-selection empty state.
  let selectedId: string | null = null
  let creating = false
  let loadToken = 0

  // --- list column ----------------------------------------------------------
  const listHeader = el('div', { class: 'git-changes-header' })
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Memories'),
    panePopoutButton(api, 'memories', 'memories'),
    el(
      'button',
      {
        type: 'button',
        class: 'git-changes-refresh-btn memories-new-btn',
        'aria-label': 'New memory',
        title: 'New memory',
      },
      '+',
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'git-changes-refresh-btn memories-refresh-btn',
        'aria-label': 'Refresh memories',
        title: 'Refresh',
      },
      '↻',
    ),
  )
  const newBtn = qsRequired<HTMLButtonElement>(listHeader, '.memories-new-btn')
  const refreshBtn = qsRequired<HTMLButtonElement>(listHeader, '.memories-refresh-btn')
  const listBody = el('div', { class: 'git-changes-list memories-list' })
  listRoot.append(listHeader, listBody)

  // --- editor column --------------------------------------------------------
  const emptyState = el(
    'div',
    { class: 'panel-empty memories-empty' },
    'Select a memory, or add one with +',
  )

  const form = el('form', { class: 'memories-form', hidden: true })
  const titleInput = el('input', {
    type: 'text',
    class: 'memories-field memories-title-input',
    placeholder: 'Title',
    'aria-label': 'Memory title',
  })
  const tagsInput = el('input', {
    type: 'text',
    class: 'memories-field memories-tags-input',
    placeholder: 'Tags (comma separated)',
    'aria-label': 'Memory tags',
  })
  const bodyInput = el('textarea', {
    class: 'memories-field memories-body-input',
    placeholder: 'Memory content (markdown)…',
    'aria-label': 'Memory content',
  })
  const metaLine = el('div', { class: 'memories-meta' })
  const errorLine = el('div', { class: 'memories-error', hidden: true })

  const saveBtn = el(
    'button',
    { type: 'submit', class: 'memories-btn memories-btn-primary' },
    'Save',
  )
  const deleteBtn = el(
    'button',
    { type: 'button', class: 'memories-btn memories-btn-danger' },
    'Delete',
  )
  const cancelBtn = el('button', { type: 'button', class: 'memories-btn' }, 'Cancel')
  const actions = el('div', { class: 'memories-actions' }, saveBtn, deleteBtn, cancelBtn)

  form.append(
    el('label', { class: 'memories-label' }, 'Title'),
    titleInput,
    el('label', { class: 'memories-label' }, 'Tags'),
    tagsInput,
    el('label', { class: 'memories-label' }, 'Content'),
    bodyInput,
    metaLine,
    errorLine,
    actions,
  )
  viewerRoot.append(emptyState, form)

  function showError(message: string): void {
    errorLine.textContent = message
    errorLine.hidden = false
  }

  /** True when the visible form holds edits not yet reflected in the stored note. */
  function isEditorDirty(note: Memory | null | undefined): boolean {
    return (
      titleInput.value !== (note?.title ?? '') ||
      tagsInput.value !== (note?.tags.join(', ') ?? '') ||
      bodyInput.value !== (note?.body ?? '')
    )
  }

  // `preserveDirty` is set by background refreshes (store events) so an in-progress
  // edit or new-note draft is not silently overwritten with the persisted values.
  // Explicit navigation (selecting a note, New, Cancel) passes it unset to load fresh.
  function renderEditor(opts?: { preserveDirty?: boolean }): void {
    errorLine.hidden = true
    const note = selectedId ? memories.find((m) => m.id === selectedId) : null
    const editing = !form.hidden
    const dirty = editing && (creating || isEditorDirty(note))
    if (!note && !creating) {
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
      titleInput.value = note?.title ?? ''
      tagsInput.value = note?.tags.join(', ') ?? ''
      bodyInput.value = note?.body ?? ''
    }
    deleteBtn.hidden = !note
    if (note?.updatedAt) {
      metaLine.hidden = false
      metaLine.textContent = `Updated ${note.updatedAt}`
    } else {
      metaLine.hidden = true
      metaLine.textContent = ''
    }
  }

  function renderList(): void {
    clear(listBody)
    if (memories.length === 0) {
      listBody.append(
        el(
          'div',
          { class: 'git-changes-empty memories-list-empty' },
          'No memories yet. The agent saves these with the remember tool, or add one with +.',
        ),
      )
      return
    }
    for (const note of memories) {
      const isSelected = note.id === selectedId
      const row = el('button', {
        type: 'button',
        class: `git-change-row memories-row${isSelected ? ' is-selected' : ''}`,
      })
      const main = el('div', { class: 'memories-row-main' })
      main.append(el('span', { class: 'memories-row-title' }, note.title || '(untitled)'))
      if (note.tags.length > 0) {
        const tagWrap = el('span', { class: 'memories-row-tags' })
        for (const tag of note.tags) {
          tagWrap.append(el('span', { class: 'memories-tag' }, tag))
        }
        main.append(tagWrap)
      }
      row.append(main)
      row.addEventListener('click', () => {
        selectedId = note.id
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
    let next: Memory[]
    try {
      next = await api.memories.list()
    } catch {
      next = []
    }
    if (token !== loadToken) return
    memories = next
    // Drop a selection whose note vanished (deleted elsewhere), but keep an
    // in-progress new-note form open.
    if (selectedId && !memories.some((m) => m.id === selectedId) && !creating) {
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
    titleInput.focus()
  }

  async function save(): Promise<void> {
    const title = titleInput.value.trim()
    const body = bodyInput.value
    const tags = parseTags(tagsInput.value)
    if (!title && !body.trim()) {
      showError('Add a title or some content before saving.')
      return
    }
    saveBtn.disabled = true
    try {
      if (creating || !selectedId) {
        const created = await api.memories.create(title, body, tags)
        selectedId = created.id
        creating = false
      } else {
        const updated = await api.memories.update(selectedId, title, body, tags)
        if (!updated) {
          showError('This memory no longer exists.')
          selectedId = null
          creating = false
        }
      }
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not save memory.')
    } finally {
      saveBtn.disabled = false
    }
  }

  async function remove(): Promise<void> {
    if (!selectedId) return
    const note = memories.find((m) => m.id === selectedId)
    if (!confirm(`Delete memory "${note?.title || 'untitled'}"?`)) return
    deleteBtn.disabled = true
    try {
      await api.memories.delete(selectedId)
      selectedId = null
      creating = false
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not delete memory.')
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

  newBtn.addEventListener('click', startNew)
  refreshBtn.addEventListener('click', () => void refresh())
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void save()
  })
  deleteBtn.addEventListener('click', () => void remove())
  cancelBtn.addEventListener('click', cancel)

  const unsubs = [
    store.on('right_panel_mode_changed', () => {
      if (memoriesModeActive(store)) void refresh({ preserveDirty: true })
    }),
    store.on('files_pane_changed', () => {
      if (memoriesModeActive(store)) void refresh({ preserveDirty: true })
    }),
    store.on('workspace_changed', () => {
      // Memories are per-project; drop the previous workspace's selection.
      selectedId = null
      creating = false
      memories = []
      if (memoriesModeActive(store)) void refresh()
      else {
        renderList()
        renderEditor()
      }
    }),
  ]

  renderList()
  renderEditor()
  // If memories are already the active pane on mount (pop-out window or restored
  // layout), the *_changed events that normally trigger the first load fired
  // before this pane existed — so catch up here.
  if (memoriesModeActive(store)) void refresh()

  return () => {
    unsubs.forEach((u) => {
      u()
    })
  }
}
