import { el, clear } from '../dom/helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { isRoadmapComplexity } from '@shared/roadmap/complexity.ts'
import { isRoadmapFit } from '@shared/roadmap/fit.ts'
import {
  ATTACHMENTS_FIELD,
  MAX_NOTE_ATTACHMENTS,
  isImageAttachment,
  parseKnowledgeAttachments,
  type KnowledgeAttachment,
} from '@shared/knowledge/attachments.ts'
import { knowledgeDate } from './knowledge-date.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// A roadmap item is one `Roadmap`-typed knowledge note. Derive the shapes from
// the IPC surface so this view never imports main-process types directly.
type RoadmapItem = Awaited<ReturnType<ApiClient['roadmap']['list']>>[number]
type RoadmapStatus = Parameters<ApiClient['roadmap']['update']>[3]
type OpenIssue = Awaited<ReturnType<ApiClient['roadmap']['openIssues']>>['issues'][number]

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

function itemIssue(item: RoadmapItem): string {
  return item.fields['issue'] ?? ''
}

function itemAttachments(item: RoadmapItem | null | undefined): KnowledgeAttachment[] {
  return item ? parseKnowledgeAttachments(item.fields[ATTACHMENTS_FIELD]) : []
}

/** A file/image the user attached in the editor but has not saved yet. */
interface PendingAttachment {
  name: string
  mimeType: string
  dataUrl: string
}

// Base64-encode via arrayBuffer() rather than FileReader so the same path runs
// in Chromium and in the happy-dom component tests.
async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

/** Decode a data URL to text, or null when the payload is not valid UTF-8
 * (a binary non-image file has no sensible composer representation). */
function dataUrlToText(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// Clipboard-pasted images often arrive named just "image.png"; keep that, but
// synthesize a name when the browser gives none at all.
function attachmentName(file: File): string {
  if (file.name) return file.name
  const ext = file.type.split('/')[1]
  return `pasted.${ext || 'bin'}`
}

// Electron prefixes errors thrown by ipcMain.handle with
// "Error invoking remote method 'x:y': Error: " — noise for the user.
function ipcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return err.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
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
  // Import-from-issues mode: the viewer column shows the open-issue picker
  // instead of the editor until the user imports or cancels.
  let importing = false
  let openIssues: OpenIssue[] = []
  // While a fit check runs, its progress/error text owns the fit box and
  // renderEditor must not overwrite it from the store.
  let fitCheckInFlight = false
  let loadToken = 0
  // Search/filter query entered in the list header.
  let searchQuery = ''

  // --- list column ----------------------------------------------------------
  const listHeader = el('div', { class: 'git-changes-header' })
  const searchInput = el('input', {
    type: 'search',
    class: 'roadmap-search-input',
    placeholder: 'Filter roadmap items…',
    'aria-label': 'Filter roadmap items',
  })
  const actionButtons = el('div', { class: 'roadmap-action-buttons' })
  const newBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn memories-new-btn roadmap-new-btn',
      'aria-label': 'New roadmap item',
      title: 'New roadmap item',
    },
    '+',
  )
  const importBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn roadmap-import-btn',
      'aria-label': 'Import from GitHub issues',
      title: 'Import from GitHub issues',
    },
    '⇩',
  )
  const refreshBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn roadmap-refresh-btn',
      'aria-label': 'Refresh roadmap',
      title: 'Refresh',
    },
    '↻',
  )
  actionButtons.append(newBtn, importBtn, refreshBtn)
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Roadmap'),
    panePopoutButton(api, 'roadmap', 'roadmap'),
    searchInput,
    actionButtons,
  )
  const listBody = el('div', { class: 'git-changes-list roadmap-list' })
  listRoot.append(listHeader, listBody)

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim()
    renderList()
  })

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
  const issueInput = el('input', {
    type: 'text',
    class: 'memories-field roadmap-issue-input',
    placeholder: 'Issue this solves (#123, owner/repo#123, or URL)',
    'aria-label': 'Pinned GitHub issue',
  })
  const statusSelect = el('select', {
    class: 'memories-field roadmap-status-select',
    'aria-label': 'Roadmap status',
  })
  for (const status of STATUS_OPTIONS) {
    statusSelect.append(el('option', { value: status }, status))
  }
  // Attachments (issue #556): pasted/dropped/picked files and images ride with
  // the item — .jsonl eval sets, screenshots for prompts — and flow into the
  // composer on "Start thread". Edits are staged (pending adds + removed ids)
  // and only persist on Save, like every other field in this form.
  let pendingAttachments: PendingAttachment[] = []
  const removedAttachmentIds = new Set<string>()
  // Thumbnails fetch lazily over IPC; cache per item/attachment so background
  // refreshes don't re-pull payloads.
  const attachmentDataCache = new Map<string, Promise<string | null>>()
  const attachmentsLabel = el('label', { class: 'memories-label' }, 'Attachments')
  const attachmentList = el('div', { class: 'roadmap-attachments' })
  const attachFileInput = el('input', {
    type: 'file',
    class: 'roadmap-attach-input',
    multiple: true,
    hidden: true,
    'aria-hidden': 'true',
    tabindex: '-1',
  })
  const attachBtn = el(
    'button',
    {
      type: 'button',
      class: 'roadmap-attach-btn',
      title: 'Attach files or images — or paste/drop them into the form',
    },
    '+ Attach',
  )
  // New items always start `ready`; the status control only applies to items
  // that already exist (matching the roadmap_plan tool's add/set_status split).
  const statusLabel = el('label', { class: 'memories-label' }, 'Status')
  const metaLine = el('div', { class: 'memories-meta' })
  const errorLine = el('div', { class: 'memories-error', hidden: true })
  const fitResult = el('div', { class: 'roadmap-fit-result', hidden: true })

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
  // Advisory: asks the small-tasks model whether executing the prompt would
  // plausibly resolve the pinned issue. Only offered while an issue is pinned.
  const fitBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-fit-btn',
      title: 'Ask the local model whether this prompt would resolve the pinned issue',
    },
    'Check fit',
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
  const actions = el(
    'div',
    { class: 'memories-actions' },
    saveBtn,
    startBtn,
    fitBtn,
    deleteBtn,
    cancelBtn,
  )

  form.append(
    el('label', { class: 'memories-label' }, 'Prompt'),
    promptInput,
    el('label', { class: 'memories-label' }, 'Notes'),
    notesInput,
    el('label', { class: 'memories-label' }, 'Issue'),
    issueInput,
    attachmentsLabel,
    attachmentList,
    attachFileInput,
    statusLabel,
    statusSelect,
    metaLine,
    errorLine,
    fitResult,
    actions,
  )
  // --- import-from-issues picker (shown in the viewer column while importing) --
  const importStatus = el('div', { class: 'memories-meta roadmap-import-status' })
  const importList = el('div', { class: 'roadmap-import-list' })
  const importConfirmBtn = el(
    'button',
    { type: 'button', class: 'memories-btn memories-btn-primary roadmap-import-confirm' },
    'Import selected',
  )
  const importCancelBtn = el(
    'button',
    { type: 'button', class: 'memories-btn roadmap-import-cancel' },
    'Cancel',
  )
  const importView = el(
    'div',
    { class: 'memories-form roadmap-import', hidden: true },
    el('label', { class: 'memories-label' }, 'Open issues'),
    importStatus,
    importList,
    el('div', { class: 'memories-actions' }, importConfirmBtn, importCancelBtn),
  )

  viewerRoot.append(emptyState, form, importView)

  function showError(message: string): void {
    errorLine.textContent = message
    errorLine.hidden = false
  }

  /** True when the visible form holds edits not yet reflected in the stored item. */
  function isEditorDirty(item: RoadmapItem | null | undefined): boolean {
    return (
      promptInput.value !== (item?.body ?? '') ||
      notesInput.value !== (item ? itemNotes(item) : '') ||
      issueInput.value !== (item ? itemIssue(item) : '') ||
      (item != null && statusSelect.value !== itemStatus(item)) ||
      pendingAttachments.length > 0 ||
      removedAttachmentIds.size > 0
    )
  }

  function currentItem(): RoadmapItem | null {
    return (selectedId && items.find((m) => m.id === selectedId)) || null
  }

  function resetAttachmentEdits(): void {
    pendingAttachments = []
    removedAttachmentIds.clear()
  }

  function attachmentDataUrl(itemId: string, attachmentId: string): Promise<string | null> {
    const key = `${itemId}/${attachmentId}`
    let cached = attachmentDataCache.get(key)
    if (!cached) {
      cached = api.roadmap.attachmentData(itemId, attachmentId).catch(() => null)
      attachmentDataCache.set(key, cached)
    }
    return cached
  }

  function attachmentChip(
    att: { name: string; mimeType: string },
    thumbSrc: string | null,
    onRemove: () => void,
  ): HTMLElement {
    const chip = el('span', { class: 'roadmap-attachment-chip', title: att.name })
    if (isImageAttachment(att)) {
      const thumb = el('img', { class: 'roadmap-attachment-thumb', alt: att.name })
      if (thumbSrc) thumb.src = thumbSrc
      chip.append(thumb)
    }
    const remove = el(
      'button',
      {
        type: 'button',
        class: 'roadmap-attachment-remove',
        'aria-label': `Remove attachment ${att.name}`,
        title: 'Remove attachment',
      },
      '✕',
    )
    remove.addEventListener('click', onRemove)
    chip.append(el('span', { class: 'roadmap-attachment-name' }, att.name), remove)
    return chip
  }

  function renderAttachments(): void {
    clear(attachmentList)
    const item = currentItem()
    for (const att of itemAttachments(item).filter((a) => !removedAttachmentIds.has(a.id))) {
      const chip = attachmentChip(att, null, () => {
        // Staged: the file is only deleted when Save sends removeAttachmentIds.
        removedAttachmentIds.add(att.id)
        renderAttachments()
      })
      if (item && isImageAttachment(att)) {
        const thumb = chip.querySelector('img')
        void attachmentDataUrl(item.id, att.id).then((url) => {
          if (url && thumb) thumb.src = url
        })
      }
      attachmentList.append(chip)
    }
    for (const pending of pendingAttachments) {
      attachmentList.append(
        attachmentChip(pending, pending.dataUrl, () => {
          pendingAttachments = pendingAttachments.filter((p) => p !== pending)
          renderAttachments()
        }),
      )
    }
    attachmentList.append(attachBtn)
  }

  async function addAttachmentFiles(files: File[]): Promise<void> {
    let count =
      itemAttachments(currentItem()).filter((a) => !removedAttachmentIds.has(a.id)).length +
      pendingAttachments.length
    for (const file of files) {
      if (count >= MAX_NOTE_ATTACHMENTS) {
        showError(`A roadmap item can hold at most ${String(MAX_NOTE_ATTACHMENTS)} attachments.`)
        break
      }
      let dataUrl: string
      try {
        dataUrl = await fileToDataUrl(file)
      } catch {
        continue
      }
      pendingAttachments.push({
        name: attachmentName(file),
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
      })
      count++
    }
    renderAttachments()
  }

  // `preserveDirty` is set by background refreshes (store events) so an in-progress
  // edit or new-item draft is not silently overwritten with the persisted values.
  // Explicit navigation (selecting an item, New, Cancel) passes it unset to load fresh.
  function renderEditor(opts?: { preserveDirty?: boolean }): void {
    errorLine.hidden = true
    importView.hidden = !importing
    if (importing) {
      form.hidden = true
      emptyState.hidden = true
      return
    }
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
      issueInput.value = item ? itemIssue(item) : ''
      statusSelect.value = item ? itemStatus(item) : 'ready'
      resetAttachmentEdits()
    }
    renderAttachments()
    statusLabel.hidden = !item
    statusSelect.hidden = !item
    startBtn.hidden = !item
    fitBtn.hidden = !item || !itemIssue(item)
    deleteBtn.hidden = !item
    // The stored verdict + reasoning render whenever the item is shown, so a
    // past check survives closing the pane. While a check is in flight,
    // checkFit owns this box (progress/error text) and blocks this rewrite.
    if (!fitCheckInFlight) {
      const fit = item ? item.fields['fit'] : undefined
      if (item && isRoadmapFit(fit)) {
        fitResult.hidden = false
        const detail = item.fields['fitDetail']
        fitResult.textContent = detail ? `fit: ${fit} — ${detail}` : `fit: ${fit}`
      } else {
        fitResult.hidden = true
        fitResult.textContent = ''
      }
    }
    if (item?.updatedAt) {
      metaLine.hidden = false
      metaLine.textContent = `Updated ${knowledgeDate(item.updatedAt)}`
    } else {
      metaLine.hidden = true
      metaLine.textContent = ''
    }
  }

  function matchesSearch(item: RoadmapItem): boolean {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (item.title || '').toLowerCase().includes(q) ||
      item.body.toLowerCase().includes(q) ||
      itemNotes(item).toLowerCase().includes(q) ||
      itemIssue(item).toLowerCase().includes(q) ||
      (item.status ?? '').toLowerCase().includes(q)
    )
  }

  function renderList(): void {
    clear(listBody)
    const visible = items.filter(matchesSearch)
    if (visible.length === 0) {
      const hint = searchQuery
        ? 'No roadmap items match your filter.'
        : 'No roadmap items yet. Jot a prompt to run later with +, or the agent records them with the roadmap_plan tool.'
      listBody.append(el('div', { class: 'git-changes-empty roadmap-list-empty' }, hint))
      return
    }
    for (const item of visible) {
      const isSelected = item.id === selectedId
      const status = itemStatus(item)
      const row = el('button', {
        type: 'button',
        class: `git-change-row memories-row roadmap-row${isSelected ? ' is-selected' : ''}`,
      })
      const main = el('div', { class: 'memories-row-main' })
      const meta = el(
        'div',
        { class: 'roadmap-row-meta' },
        el('span', { class: `roadmap-status-badge is-${status}` }, status),
      )
      // Complexity is stamped in the background shortly after a save
      // (roadmap-complexity.ts); freshly saved items and older items that
      // predate stamping simply have no badge yet.
      const complexity = item.fields['complexity']
      if (isRoadmapComplexity(complexity)) {
        meta.append(
          el(
            'span',
            {
              class: `roadmap-complexity-badge is-${complexity}`,
              title: 'Estimated prompt complexity (classified after save)',
            },
            complexity,
          ),
        )
      }
      // A fit verdict survives until the prompt or pin changes (the update
      // path drops stale ones).
      const fit = item.fields['fit']
      if (isRoadmapFit(fit)) {
        meta.append(
          el(
            'span',
            {
              class: `roadmap-fit-badge is-${fit}`,
              title: 'Model verdict: would this prompt resolve the pinned issue?',
            },
            `fit: ${fit}`,
          ),
        )
      }
      const issue = itemIssue(item)
      if (issue) {
        const chip = el(
          'span',
          {
            class: 'roadmap-issue-chip',
            role: 'link',
            title: `Open ${issue} on GitHub`,
          },
          issue,
        )
        chip.addEventListener('click', (e) => {
          // The row itself selects the item; the chip only opens the issue.
          e.stopPropagation()
          void api.roadmap.issueUrl(issue).then((url) => {
            if (url) void api.shell.openExternal(url)
          })
        })
        meta.append(chip)
      }
      const attachmentCount = itemAttachments(item).length
      if (attachmentCount > 0) {
        meta.append(
          el(
            'span',
            {
              class: 'roadmap-attachment-badge',
              title: `${String(attachmentCount)} attachment${attachmentCount === 1 ? '' : 's'}`,
            },
            // The shared paperclip SVG (attachment-icons.ts) — theme-aware
            // `currentColor` stroke, never an emoji glyph.
            attachmentIcon('file', 'ui-icon roadmap-attachment-badge-icon'),
            String(attachmentCount),
          ),
        )
      }

      // One-click status flip without opening the editor: ✓ marks a live item
      // done, ↺ reopens a done one. Archived items keep the editor-only flow.
      // A span with role=button, like the issue chip — rows are <button>s and
      // buttons cannot nest.
      if (status !== 'archived') {
        const isDone = status === 'done'
        const toggle = el(
          'span',
          {
            class: 'roadmap-done-toggle',
            role: 'button',
            title: isDone ? 'Reopen (set ready)' : 'Mark done',
            'aria-label': isDone ? 'Reopen roadmap item' : 'Mark roadmap item done',
          },
          isDone ? '↺' : '✓',
        )
        toggle.addEventListener('click', (e) => {
          // The row itself selects the item; the toggle only flips status.
          e.stopPropagation()
          void setStatus(item, isDone ? 'ready' : 'done')
        })
         meta.append(toggle)
      }
      main.append(
        el('span', { class: 'memories-row-title roadmap-row-title' }, item.title || '(untitled)'),
        meta,
      )
      row.append(main)
      row.addEventListener('click', () => {
        selectedId = item.id
        creating = false
        importing = false
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
    importing = false
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
    const issue = issueInput.value.trim()
    const addAttachments = pendingAttachments.map(({ name, mimeType, dataUrl }) => ({
      name,
      mimeType,
      dataUrl,
    }))
    const removeIds = [...removedAttachmentIds]
    saveBtn.disabled = true
    try {
      if (creating || !selectedId) {
        const created = await api.roadmap.create(
          prompt,
          notes || undefined,
          issue || undefined,
          addAttachments.length > 0 ? addAttachments : undefined,
        )
        selectedId = created.id
        creating = false
      } else {
        const updated = await api.roadmap.update(
          selectedId,
          prompt,
          notes || undefined,
          statusSelect.value as RoadmapStatus,
          issue || undefined,
          addAttachments.length > 0 ? addAttachments : undefined,
          removeIds.length > 0 ? removeIds : undefined,
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
    if (
      !(await showConfirmDialog({
        message: `Delete roadmap item "${item?.title || 'untitled'}"?`,
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return
    }
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

  // Row-level status flip (✓ / ↺). Status-only IPC — never re-classifies the
  // prompt. If the flipped item is open in the editor, sync its status select
  // first so the dirty check passes and a later Save can't quietly revert it.
  async function setStatus(item: RoadmapItem, status: RoadmapStatus): Promise<void> {
    try {
      const updated = await api.roadmap.setStatus(item.id, status)
      if (updated && selectedId === item.id) statusSelect.value = status
      await refresh({ preserveDirty: true })
    } catch (err) {
      showError(ipcErrorMessage(err, 'Could not update the roadmap item status.'))
    }
  }

  async function checkFit(): Promise<void> {
    if (!selectedId) return
    fitBtn.disabled = true
    fitCheckInFlight = true
    fitResult.hidden = false
    fitResult.textContent = 'Checking fit against the pinned issue…'
    try {
      await api.roadmap.checkFit(selectedId)
      // The verdict + reasoning were stamped into the note; re-render from the
      // store (the durable form) without clobbering open edits.
      fitCheckInFlight = false
      await refresh({ preserveDirty: true })
    } catch (err) {
      fitResult.textContent = ipcErrorMessage(err, 'Fit check failed.')
    } finally {
      fitCheckInFlight = false
      fitBtn.disabled = false
    }
  }

  // Open a fresh thread pre-filled with the item's prompt (plus its notes as a
  // trailing context line). Uses the editor's *current* text so an unsaved
  // tweak goes to the thread the user is looking at, not a stale stored copy.
  // The item's attachments ride along into the composer: images as image
  // attachments, text files (.jsonl eval sets and the like) as file chips.
  async function startThread(): Promise<void> {
    const prompt = promptInput.value.trim()
    if (!prompt) {
      showError('Add a prompt before starting a thread.')
      return
    }
    const notes = notesInput.value.trim()
    const draft = notes ? `${prompt}\n\nNotes: ${notes}` : prompt
    // Fetch stored payloads before switching threads; pending (unsaved) ones
    // are already in memory and go along too, matching the visible chip row.
    const item = currentItem()
    const payloads: PendingAttachment[] = []
    if (item) {
      for (const att of itemAttachments(item).filter((a) => !removedAttachmentIds.has(a.id))) {
        const dataUrl = await attachmentDataUrl(item.id, att.id)
        if (dataUrl) payloads.push({ name: att.name, mimeType: att.mimeType, dataUrl })
      }
    }
    payloads.push(...pendingAttachments)
    // Persist whatever is in the chat composer to its thread before switching.
    store.emit('composer_draft_flush')
    createThread(store, draft)
    const handlers = getPromptAttachmentHandlers()
    if (handlers) {
      for (const payload of payloads) {
        if (payload.mimeType.startsWith('image/')) {
          handlers.attachImage(payload.dataUrl, payload.mimeType)
        } else {
          const text = dataUrlToText(payload.dataUrl)
          if (text !== null) handlers.attachFile({ path: payload.name, content: text })
        }
      }
    }
    handlers?.focusComposer?.()
  }

  // --- import-from-issues flow -----------------------------------------------
  function issueAlreadyPinned(issue: OpenIssue): boolean {
    const short = `#${String(issue.number)}`
    const full = `${issue.owner}/${issue.repo}${short}`
    return items.some((i) => itemIssue(i) === short || itemIssue(i) === full)
  }

  function renderImportList(): void {
    clear(importList)
    for (const issue of openIssues) {
      const pinned = issueAlreadyPinned(issue)
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'roadmap-import-check',
        'data-number': String(issue.number),
        disabled: pinned,
      })
      const label = el(
        'label',
        { class: `roadmap-import-row${pinned ? ' is-pinned' : ''}` },
        checkbox,
        el('span', { class: 'roadmap-import-title' }, `#${String(issue.number)} ${issue.title}`),
      )
      if (pinned) label.append(el('span', { class: 'memories-meta' }, 'already on roadmap'))
      importList.append(label)
    }
  }

  function startImport(): void {
    importing = true
    creating = false
    selectedId = null
    openIssues = []
    clear(importList)
    importConfirmBtn.disabled = false
    importStatus.textContent = 'Loading open issues…'
    renderList()
    renderEditor()
    void api.roadmap
      .openIssues()
      .then(({ slug, issues }) => {
        if (!importing) return
        openIssues = issues
        // Naming the queried repo surfaces a stale or fork origin at a glance.
        importStatus.textContent = issues.length
          ? `Pick the issues to turn into roadmap prompts (${slug}).`
          : `No open issues found in ${slug}.`
        renderImportList()
      })
      .catch((err: unknown) => {
        if (!importing) return
        importStatus.textContent = ipcErrorMessage(err, 'Could not list open issues.')
      })
  }

  async function confirmImport(): Promise<void> {
    const selected = [...importList.querySelectorAll<HTMLInputElement>('.roadmap-import-check')]
      .filter((c) => c.checked)
      .map((c) => Number(c.dataset['number']))
    const payload = openIssues
      .filter((i) => selected.includes(i.number))
      .map((i) => ({ number: i.number, title: i.title, body: i.body }))
    if (payload.length === 0) {
      importStatus.textContent = 'Select at least one issue to import.'
      return
    }
    importConfirmBtn.disabled = true
    try {
      // One issue per call so each item lands on the roadmap as soon as its
      // prompt is drafted, instead of after the whole batch. On failure the
      // already-imported items stay and the picker reports where it stopped.
      for (const [index, issue] of payload.entries()) {
        importStatus.textContent = `Drafting prompt ${String(index + 1)} of ${String(payload.length)}: #${String(issue.number)}…`
        await api.roadmap.importIssues([issue])
        if (!importing) return
        await refresh({ preserveDirty: true })
        renderImportList()
      }
      importing = false
      await refresh()
    } catch (err) {
      importStatus.textContent = ipcErrorMessage(err, 'Could not import the selected issues.')
      renderImportList()
    } finally {
      importConfirmBtn.disabled = false
    }
  }

  function cancelImport(): void {
    importing = false
    renderEditor()
  }

  importBtn.addEventListener('click', startImport)
  importConfirmBtn.addEventListener('click', () => void confirmImport())
  importCancelBtn.addEventListener('click', cancelImport)

  newBtn.addEventListener('click', startNew)
  refreshBtn.addEventListener('click', () => void refresh())
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void save()
  })
  startBtn.addEventListener('click', () => void startThread())

  // Pasted files/images anywhere in the form become attachments. Stop
  // propagation for handled pastes: the chat input bar owns a document-level
  // paste listener (input-bar.ts) that would otherwise claim any pasted image
  // for the composer even while the roadmap editor has focus. Plain text
  // pastes fall through to the focused field untouched.
  form.addEventListener('paste', (e) => {
    // Read `items` first — the same source the composer's handler uses — so a
    // pasted image that Chromium surfaces only there is still claimed here;
    // `files` is the fallback (and what synthetic test events provide).
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) files.push(...Array.from(e.clipboardData?.files ?? []))
    if (files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    void addAttachmentFiles(files)
  })
  // Files dropped on the form attach to the item rather than falling through
  // to the window (or the chat composer's drop target).
  form.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    form.classList.add('is-drop-target')
  })
  form.addEventListener('dragleave', (e) => {
    if (!form.contains(e.relatedTarget as Node)) form.classList.remove('is-drop-target')
  })
  form.addEventListener('drop', (e) => {
    form.classList.remove('is-drop-target')
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    void addAttachmentFiles(files)
  })
  attachBtn.addEventListener('click', () => {
    attachFileInput.click()
  })
  attachFileInput.addEventListener('change', () => {
    const files = Array.from(attachFileInput.files ?? [])
    // Reset so re-picking the same file fires `change` again.
    attachFileInput.value = ''
    if (files.length > 0) void addAttachmentFiles(files)
  })
  fitBtn.addEventListener('click', () => void checkFit())
  deleteBtn.addEventListener('click', () => void remove())
  cancelBtn.addEventListener('click', cancel)

  const unsubs = [
    store.on('right_panel_mode_changed', () => {
      if (roadmapModeActive(store)) void refresh({ preserveDirty: true })
    }),
    store.on('files_pane_changed', () => {
      if (roadmapModeActive(store)) void refresh({ preserveDirty: true })
    }),
    // Saves return before their complexity stamp lands (roadmap-complexity.ts);
    // pick the badge up when main says the stamp arrived.
    api.roadmap.onChanged(() => {
      if (roadmapModeActive(store)) void refresh({ preserveDirty: true })
    }),
    // The quick-open palette (Cmd/Ctrl+P) lands here after opening the pane:
    // select the chosen item and load fresh so its editor shows immediately.
    store.on('roadmap_reveal', (itemId) => {
      selectedId = itemId
      creating = false
      importing = false
      void refresh()
    }),
    store.on('workspace_changed', () => {
      // The roadmap is per-project; drop the previous workspace's selection.
      selectedId = null
      creating = false
      importing = false
      items = []
      resetAttachmentEdits()
      attachmentDataCache.clear()
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
