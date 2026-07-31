import { el, clear } from '../dom/helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { showContextMenu } from '../dom/context-menu.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import {
  ROADMAP_EXPORT_FORMATS,
  downloadRoadmapExport,
  roadmapExportFormatLabel,
} from '../export-roadmap.ts'
import { registerPopoutSeedHandlers } from '../popout/pane-popout-seed.ts'
import {
  ROADMAP_CATEGORIES,
  ROADMAP_COMPLEXITIES,
  isRoadmapCategory,
  isRoadmapComplexity,
  roadmapCategoryLabel,
  type RoadmapCategory,
  type RoadmapComplexity,
} from '@shared/roadmap/complexity.ts'
import { isRoadmapFit } from '@shared/roadmap/fit.ts'
import type { RoadmapIssueCoverageMatch } from '@shared/roadmap/coverage.ts'
import {
  ATTACHMENTS_FIELD,
  MAX_NOTE_ATTACHMENTS,
  isImageAttachment,
  parseKnowledgeAttachments,
  type KnowledgeAttachment,
} from '@shared/knowledge/attachments.ts'
import {
  isRoadmapReviewVerdict,
  isReviewStale,
  reviewDetailMarkdown,
} from '@shared/roadmap/review.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { knowledgeDate } from './knowledge-date.ts'
import { createThread, getThreadById, switchThread } from '@shared/store/thread-helpers.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import { checkIcon, refreshIcon } from '../dom/icons.ts'
import { attachImageExpand } from '../attachments/image-expand.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { firstNonEmptyString, nonEmptyStringOr } from '@shared/unknown-value.ts'

// A roadmap item is one `Roadmap`-typed knowledge note. Derive the shapes from
// the IPC surface so this view never imports main-process types directly.
type RoadmapItem = Awaited<ReturnType<ApiClient['roadmap']['list']>>[number]
type RoadmapStatus = Parameters<ApiClient['roadmap']['update']>[3]
type OpenIssue = Awaited<ReturnType<ApiClient['roadmap']['openIssues']>>['issues'][number]
type ReviewItemResult = Awaited<ReturnType<ApiClient['roadmap']['reviewItem']>>

// The lifecycle the roadmap_plan tool maintains; the IPC layer re-validates, so
// a drifted entry here fails loudly rather than corrupting a note.
const STATUS_OPTIONS: readonly RoadmapStatus[] = [
  'ready',
  'blocked',
  'conflicts',
  'done',
  'archived',
]

/** Statuses that earn a list chip. `ready` is the default (silent); `done` is
 * title strikethrough only — see docs/ui-taste.md "Roadmap list rows". */
const LIST_STATUS_BADGES = new Set<RoadmapStatus>(['blocked', 'conflicts', 'archived'])

function isRoadmapStatus(value: unknown): value is RoadmapStatus {
  return STATUS_OPTIONS.some((status) => status === value)
}

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

/** Unsaved editor state stashed when switching items or leaving a new-item form. */
interface EditorDraft {
  prompt: string
  notes: string
  issue: string
  status: RoadmapStatus
  category: RoadmapCategory | ''
  pendingAttachments: PendingAttachment[]
  removedAttachmentIds: string[]
}

const NEW_ITEM_DRAFT_KEY = '__new__'

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
  return `pasted.${nonEmptyStringOr(ext, 'bin')}`
}

/** Id of the thread last started from this item ("Start thread"), if tracked. */
function itemThreadId(item: RoadmapItem): string {
  return item.fields['thread'] ?? ''
}

// Electron prefixes errors thrown by ipcMain.handle with
// "Error invoking remote method 'x:y': Error: " — noise for the user.
function ipcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return err.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
}

function toRoadmapStatus(value: string | null | undefined): RoadmapStatus {
  return STATUS_OPTIONS.find((status) => status === value) ?? 'ready'
}

function itemStatus(item: RoadmapItem): RoadmapStatus {
  return isRoadmapStatus(item.status) ? item.status : 'ready'
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
  // Review mode: model-judged resolution status for each active item.
  let reviewing = false
  /** Item opened from the review triage panel while bulk review is still running. */
  let reviewPeekId: string | null = null
  let reviewResults: ReviewItemResult[] = []
  /** Status the user applied from the review triage panel (id → new status). */
  const reviewApplied = new Map<string, RoadmapStatus>()
  /** True after a bulk ◎ run finishes — Close advances the commit checkpoint. */
  let bulkReviewFinished = false
  /** True while prepareReview/reviewItem loop is running (including prepare). */
  let reviewInFlight = false
  let bulkRunId: string | null = null
  let reviewRunToken = 0
  let cachedCheckpoint:
    | {
        lastReviewAt: string | null
        lastAcknowledgedBulkRun: string | null
        pendingBulkRun: string | null
      }
    | undefined
  let openIssues: OpenIssue[] = []
  let openIssuePage = 0
  let openIssueSlug = ''
  let moreOpenIssues = false
  /** Model-judged coverage of open issues by existing (unpinned) roadmap items. */
  let issueCoverage = new Map<number, RoadmapIssueCoverageMatch>()
  let coverageToken = 0
  // While a fit check runs, its progress/error text owns the fit box and
  // renderEditor must not overwrite it from the store.
  let fitCheckInFlight = false
  // While a deep resolution check runs, the review result box is owned in-flight
  // for that item only — switching selection clears the spinner immediately.
  let resolutionCheckInFlight = false
  let resolutionCheckItemId: string | null = null
  let resolutionCheckToken = 0
  let loadToken = 0
  // True while the first (or a re-triggered empty-list) fetch is in flight, so
  // renderList() can show "Loading…" instead of the "No roadmap items yet"
  // empty state — a large roadmap's fetch can take a while and the two look
  // identical otherwise.
  let loading = false
  // Text and facet filters entered in the list header. Every facet starts
  // enabled, including legacy items that have not been stamped yet.
  let searchQuery = ''
  const enabledCategories = new Set<RoadmapCategory | 'uncategorized'>([
    ...ROADMAP_CATEGORIES,
    'uncategorized',
  ])
  const enabledComplexities = new Set<RoadmapComplexity | 'unestimated'>([
    ...ROADMAP_COMPLEXITIES,
    'unestimated',
  ])
  const enabledStatuses = new Set<RoadmapStatus>(STATUS_OPTIONS)
  const collapsedCategories = new Set<RoadmapCategory | 'uncategorized'>()
  // Done items are hidden by default; the header toggle reveals them.
  let showDone = false
  /** In-progress edits keyed by item id, or {@link NEW_ITEM_DRAFT_KEY} for a new item. */
  const editorDrafts = new Map<string, EditorDraft>()
  /** Ignores stale auto-save responses when the user leaves and re-enters quickly. */
  const autoSaveToken = new Map<string, number>()

  // --- list column ----------------------------------------------------------
  const listHeader = el('div', { class: 'git-changes-header' })
  const filter = el('div', { class: 'roadmap-filter' })
  const searchInput = el('input', {
    type: 'search',
    class: 'roadmap-search-input',
    placeholder: 'Search roadmap…',
    'aria-label': 'Search roadmap items',
  })
  const filterToggle = el(
    'button',
    {
      type: 'button',
      class: 'roadmap-filter-toggle',
      'aria-label': 'Filter roadmap items',
      'aria-expanded': 'false',
      title: 'Filter by category, complexity, or status',
    },
    'Filter',
  )
  const filterMenu = el('div', {
    class: 'roadmap-filter-menu',
    role: 'group',
    'aria-label': 'Roadmap filters',
    hidden: true,
  })
  filter.append(searchInput, filterToggle, filterMenu)
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
  const reviewBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn roadmap-review-btn',
      'aria-label': 'Review roadmap resolution',
      title: 'Review whether roadmap items have been resolved',
    },
    '◎',
  )
  const showDoneBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn roadmap-show-done-btn',
      'aria-label': 'Show done items',
      'aria-pressed': 'false',
      title: 'Show done items',
    },
    'done',
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
  const exportBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn roadmap-export-btn',
      'aria-label': 'Export roadmap',
      title: 'Export roadmap as a file',
    },
    '⇧',
  )
  exportBtn.addEventListener('click', () => {
    const rect = exportBtn.getBoundingClientRect()
    showContextMenu(
      rect.left,
      rect.bottom,
      ROADMAP_EXPORT_FORMATS.map((format) => ({
        label: roadmapExportFormatLabel(format),
        onSelect: (): void => {
          void downloadRoadmapExport(api, format)
        },
      })),
    )
  })
  actionButtons.append(newBtn, importBtn, reviewBtn, showDoneBtn, exportBtn, refreshBtn)
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Roadmap'),
    panePopoutButton(api, 'roadmap', 'roadmap'),
    filter,
    actionButtons,
  )
  const listBody = el('div', { class: 'git-changes-list roadmap-list' })
  listRoot.append(listHeader, listBody)

  function syncShowDoneBtn(): void {
    showDoneBtn.setAttribute('aria-pressed', showDone ? 'true' : 'false')
    showDoneBtn.classList.toggle('is-active', showDone)
    showDoneBtn.title = showDone ? 'Hide done items' : 'Show done items'
    showDoneBtn.setAttribute('aria-label', showDone ? 'Hide done items' : 'Show done items')
  }

  function appendFilterSection<T extends string>(
    title: string,
    values: readonly T[],
    enabled: Set<T>,
    label: (value: T) => string,
  ): void {
    filterMenu.append(el('div', { class: 'roadmap-filter-heading' }, title))
    for (const value of values) {
      const checkbox = el('input', { type: 'checkbox', checked: true })
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) enabled.add(value)
        else enabled.delete(value)
        renderList()
      })
      filterMenu.append(
        el('label', { class: 'roadmap-filter-option' }, checkbox, el('span', {}, label(value))),
      )
    }
  }

  appendFilterSection(
    'Category',
    [...ROADMAP_CATEGORIES, 'uncategorized'],
    enabledCategories,
    (category) => (category === 'uncategorized' ? 'Uncategorized' : roadmapCategoryLabel(category)),
  )
  appendFilterSection(
    'Complexity',
    [...ROADMAP_COMPLEXITIES, 'unestimated'],
    enabledComplexities,
    (complexity) => (complexity === 'unestimated' ? 'Unestimated' : complexity),
  )
  appendFilterSection('Status', STATUS_OPTIONS, enabledStatuses, (status) => status)

  function closeFilterMenu(): void {
    filterMenu.hidden = true
    filterToggle.setAttribute('aria-expanded', 'false')
  }

  filterToggle.addEventListener('click', () => {
    const opening = filterMenu.hidden
    filterMenu.hidden = !opening
    filterToggle.setAttribute('aria-expanded', opening ? 'true' : 'false')
  })
  const closeFilterOnOutsideClick = (event: Event): void => {
    if (event.target instanceof Node && !filter.contains(event.target)) closeFilterMenu()
  }
  document.addEventListener('click', closeFilterOnOutsideClick)

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim()
    renderList()
  })
  showDoneBtn.addEventListener('click', () => {
    showDone = !showDone
    syncShowDoneBtn()
    renderList()
  })
  syncShowDoneBtn()

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
  const categorySelect = el('select', {
    class: 'memories-field roadmap-category-select',
    'aria-label': 'Roadmap category',
  })
  categorySelect.append(el('option', { value: '' }, 'Auto'))
  for (const category of ROADMAP_CATEGORIES) {
    categorySelect.append(el('option', { value: category }, roadmapCategoryLabel(category)))
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
  const reviewResult = el('div', { class: 'roadmap-review-result', hidden: true })
  const reviewResultMeta = el('div', { class: 'roadmap-review-result-meta' })
  const reviewResultBody = el('div', {
    class: 'roadmap-review-result-body message-text streaming-markdown',
  })
  reviewResult.append(reviewResultMeta, reviewResultBody)

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
  // Switches back to the thread previously started from this item (tracked in
  // the note's `thread` field). Offered only while that thread still exists;
  // hidden in pop-out windows alongside Start thread (popout.css).
  const reopenBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-reopen-btn',
      title: 'Switch to the thread previously started from this item',
    },
    'Reopen thread',
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
  const resolutionBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-resolution-btn',
      title: 'Deep resolution check — full commit history since this item was created',
    },
    'Check resolution',
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
  const reviewBackBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-review-back',
      title: 'Return to the in-progress review results',
    },
    'Back to review',
  )
  const actions = el(
    'div',
    { class: 'memories-actions' },
    saveBtn,
    startBtn,
    reopenBtn,
    fitBtn,
    resolutionBtn,
    deleteBtn,
    reviewBackBtn,
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
    el('label', { class: 'memories-label' }, 'Category'),
    categorySelect,
    statusLabel,
    statusSelect,
    metaLine,
    errorLine,
    fitResult,
    reviewResult,
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
  const importLoadMoreBtn = el(
    'button',
    { type: 'button', class: 'memories-btn roadmap-import-more', hidden: true },
    'Load more',
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
    el('div', { class: 'memories-actions' }, importLoadMoreBtn, importConfirmBtn, importCancelBtn),
  )

  const reviewStatus = el('div', { class: 'memories-meta roadmap-review-status' })
  const reviewList = el('div', { class: 'roadmap-review-list' })
  const reviewStopBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-review-stop',
      title: 'Stop the in-progress review',
    },
    'Stop',
  )
  const reviewCloseBtn = el(
    'button',
    { type: 'button', class: 'memories-btn roadmap-review-close' },
    'Close',
  )
  const reviewMarkResolvedBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn memories-btn-primary roadmap-review-mark-resolved',
      title: 'Mark every resolved/likely item as done',
    },
    'Mark resolved done',
  )
  const reviewArchiveResolvedBtn = el(
    'button',
    {
      type: 'button',
      class: 'memories-btn roadmap-review-archive-resolved',
      title: 'Archive every resolved/likely item',
    },
    'Archive resolved',
  )
  const reviewView = el(
    'div',
    { class: 'memories-form roadmap-review', hidden: true },
    el('label', { class: 'memories-label' }, 'Review results'),
    reviewStatus,
    reviewList,
    el(
      'div',
      { class: 'memories-actions roadmap-review-actions' },
      reviewStopBtn,
      reviewMarkResolvedBtn,
      reviewArchiveResolvedBtn,
      reviewCloseBtn,
    ),
  )

  viewerRoot.append(emptyState, form, importView, reviewView)

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
      categorySelect.value !==
        (item && item.fields['categoryManual'] && isRoadmapCategory(item.fields['category'])
          ? item.fields['category']
          : '') ||
      pendingAttachments.length > 0 ||
      removedAttachmentIds.size > 0
    )
  }

  function currentItem(): RoadmapItem | null {
    return selectedId === null ? null : (items.find((item) => item.id === selectedId) ?? null)
  }

  function currentDraftKey(): string | null {
    if (creating) return NEW_ITEM_DRAFT_KEY
    return selectedId
  }

  function hasNewItemContent(): boolean {
    return (
      promptInput.value !== '' ||
      notesInput.value !== '' ||
      issueInput.value !== '' ||
      pendingAttachments.length > 0
    )
  }

  function captureEditorDraft(): EditorDraft | null {
    const key = currentDraftKey()
    if (!key) return null
    const item = currentItem()
    const dirty = creating ? hasNewItemContent() : isEditorDirty(item)
    if (!dirty) {
      editorDrafts.delete(key)
      return null
    }
    const draft: EditorDraft = {
      prompt: promptInput.value,
      notes: notesInput.value,
      issue: issueInput.value,
      status: toRoadmapStatus(statusSelect.value),
      category: isRoadmapCategory(categorySelect.value) ? categorySelect.value : '',
      pendingAttachments: pendingAttachments.map((pending) => ({ ...pending })),
      removedAttachmentIds: [...removedAttachmentIds],
    }
    editorDrafts.set(key, draft)
    return draft
  }

  function applyEditorDraft(draft: EditorDraft): void {
    promptInput.value = draft.prompt
    notesInput.value = draft.notes
    issueInput.value = draft.issue
    statusSelect.value = draft.status
    categorySelect.value = draft.category
    pendingAttachments = draft.pendingAttachments.map((pending) => ({ ...pending }))
    removedAttachmentIds.clear()
    for (const id of draft.removedAttachmentIds) removedAttachmentIds.add(id)
  }

  function draftsMatch(a: EditorDraft, b: EditorDraft): boolean {
    return (
      a.prompt === b.prompt &&
      a.notes === b.notes &&
      a.issue === b.issue &&
      a.status === b.status &&
      a.category === b.category &&
      a.pendingAttachments.length === b.pendingAttachments.length &&
      a.pendingAttachments.every((pending, index) => {
        const other = b.pendingAttachments[index]
        return (
          other !== undefined &&
          pending.name === other.name &&
          pending.mimeType === other.mimeType &&
          pending.dataUrl === other.dataUrl
        )
      }) &&
      a.removedAttachmentIds.length === b.removedAttachmentIds.length &&
      a.removedAttachmentIds.every((id) => b.removedAttachmentIds.includes(id))
    )
  }

  async function autoSaveDraft(id: string, draft: EditorDraft): Promise<void> {
    const prompt = draft.prompt.trim()
    if (!prompt) return
    const token = (autoSaveToken.get(id) ?? 0) + 1
    autoSaveToken.set(id, token)
    const addAttachments = draft.pendingAttachments.map(({ name, mimeType, dataUrl }) => ({
      name,
      mimeType,
      dataUrl,
    }))
    const removeIds = draft.removedAttachmentIds
    try {
      const updated = await api.roadmap.update(
        id,
        prompt,
        draft.notes.trim() || undefined,
        draft.status,
        draft.issue.trim() || undefined,
        addAttachments.length > 0 ? addAttachments : undefined,
        removeIds.length > 0 ? removeIds : undefined,
      )
      if (autoSaveToken.get(id) !== token || !updated) return
      const storedCategory =
        updated.fields['categoryManual'] && isRoadmapCategory(updated.fields['category'])
          ? updated.fields['category']
          : ''
      const categorized =
        draft.category === storedCategory
          ? updated
          : await api.roadmap.setCategory(id, draft.category)
      if (autoSaveToken.get(id) !== token || !categorized) return
      const index = items.findIndex((item) => item.id === id)
      if (index >= 0) items[index] = categorized
      const current = editorDrafts.get(id)
      if (current && draftsMatch(current, draft)) editorDrafts.delete(id)
      if (selectedId !== id) renderList()
    } catch {
      // The in-memory draft captured on leave remains available for restoration.
    }
  }

  /** Stash or persist the open editor before navigating to another item or form. */
  function leaveCurrentEditor(): void {
    const key = currentDraftKey()
    if (!key) return
    const draft = captureEditorDraft()
    if (!draft || creating || !selectedId) return
    if (draft.prompt.trim()) void autoSaveDraft(selectedId, draft)
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
      attachImageExpand(thumb, att.name)
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

  /** Keep the viewer column aligned with import/review overlays vs the editor. */
  function syncViewerMode(): void {
    importView.hidden = !importing
    const reviewPanelActive = reviewing && !reviewPeekId
    reviewView.hidden = !reviewPanelActive
    if (importing || reviewPanelActive) {
      form.hidden = true
      emptyState.hidden = true
    }
  }

  // `preserveDirty` is set by background refreshes (store events) so an in-progress
  // edit or new-item draft is not silently overwritten with the persisted values.
  // Explicit navigation (selecting an item, New, Cancel) passes it unset to load fresh.
  function renderEditor(opts?: { preserveDirty?: boolean }): void {
    errorLine.hidden = true
    syncViewerMode()
    if (importing || (reviewing && !reviewPeekId)) {
      return
    }
    const item = selectedId ? items.find((m) => m.id === selectedId) : null
    const editing = !form.hidden
    const dirty = editing && (creating || isEditorDirty(item))
    if (!item && !creating) {
      // Keep an in-progress draft visible rather than collapsing to the empty
      // state when a refresh fires while the user is typing. Never bail out
      // while an overlay owns the viewer — that would leave the item form visible
      // on top of (or instead of) the review/import panel.
      if (opts?.preserveDirty && dirty) return
      form.hidden = true
      emptyState.hidden = false
      return
    }
    emptyState.hidden = true
    form.hidden = false
    if (!(opts?.preserveDirty && dirty)) {
      const draftKey = creating ? NEW_ITEM_DRAFT_KEY : selectedId
      const draft = draftKey ? editorDrafts.get(draftKey) : undefined
      if (draft) {
        applyEditorDraft(draft)
      } else {
        promptInput.value = item?.body ?? ''
        notesInput.value = item ? itemNotes(item) : ''
        issueInput.value = item ? itemIssue(item) : ''
        statusSelect.value = item ? itemStatus(item) : 'ready'
        categorySelect.value =
          item && item.fields['categoryManual'] && isRoadmapCategory(item.fields['category'])
            ? item.fields['category']
            : ''
        resetAttachmentEdits()
      }
    }
    renderAttachments()
    statusLabel.hidden = !item
    statusSelect.hidden = !item
    startBtn.hidden = !item
    // Reopen only while the tracked thread still exists — a deleted thread
    // leaves the field pointing at nothing, and Start thread restamps it.
    reopenBtn.hidden = !item || !getThreadById(store, itemThreadId(item))
    fitBtn.hidden = !item || !itemIssue(item)
    resolutionBtn.hidden = !item || item.status === 'done' || item.status === 'archived'
    deleteBtn.hidden = !item
    reviewBackBtn.hidden = !(reviewing && reviewPeekId != null)
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
    const review = item ? item.fields['reviewVerdict'] : undefined
    const showingResolutionCheck =
      resolutionCheckInFlight && item != null && resolutionCheckItemId === item.id
    if (showingResolutionCheck) {
      reviewResult.hidden = false
      reviewResultMeta.textContent = 'Deep resolution check…'
      reviewResultBody.hidden = true
      reviewResultBody.replaceChildren()
    } else if (item && isRoadmapReviewVerdict(review)) {
      reviewResult.hidden = false
      const detail = item.fields['reviewDetail']
      const at = item.fields['reviewAt']
      const depth = item.fields['reviewDepth']
      const when = at ? ` (${knowledgeDate(at)})` : ''
      const depthLabel = depth === 'deep' ? ' · deep check' : ''
      void ensureCheckpoint().then((checkpoint) => {
        if (selectedId !== item.id || resolutionCheckItemId === item.id) return
        const stale = isReviewStale(item.fields, item.status, checkpoint)
        const staleLabel = stale ? ' · stale — re-check recommended' : ''
        reviewResultMeta.textContent = `review: ${review}${when}${depthLabel}${staleLabel}`
      })
      if (detail) {
        reviewResultBody.hidden = false
        reviewResultBody.innerHTML = renderMarkdown(reviewDetailMarkdown(detail))
      } else {
        reviewResultBody.hidden = true
        reviewResultBody.replaceChildren()
      }
    } else {
      reviewResult.hidden = true
      reviewResultMeta.textContent = ''
      reviewResultBody.replaceChildren()
      reviewResultBody.hidden = true
    }
    if (item?.updatedAt) {
      metaLine.hidden = false
      const updatedTime = new Date(item.updatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
      metaLine.textContent = `Updated ${knowledgeDate(item.updatedAt)} at ${updatedTime}`
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

  function itemCategory(item: RoadmapItem): RoadmapCategory | 'uncategorized' {
    const category = item.fields['category']
    return isRoadmapCategory(category) ? category : 'uncategorized'
  }

  function itemComplexity(item: RoadmapItem): RoadmapComplexity | 'unestimated' {
    const complexity = item.fields['complexity']
    return isRoadmapComplexity(complexity) ? complexity : 'unestimated'
  }

  function isListVisible(item: RoadmapItem): boolean {
    const status = itemStatus(item)
    if (!showDone && status === 'done') return false
    return (
      enabledCategories.has(itemCategory(item)) &&
      enabledComplexities.has(itemComplexity(item)) &&
      enabledStatuses.has(status) &&
      matchesSearch(item)
    )
  }

  function renderList(): void {
    clear(listBody)
    const visible = items.filter(isListVisible)
    if (visible.length === 0) {
      let hint = loading
        ? 'Loading roadmap…'
        : 'No roadmap items yet. Jot a prompt to run later with +, or the agent records them with the roadmap_plan tool.'
      if (!loading && searchQuery) {
        hint = 'No roadmap items match your filter.'
      } else if (!showDone && items.some((item) => itemStatus(item) === 'done')) {
        hint = 'No open roadmap items. Turn on "done" to see completed work.'
      }
      listBody.append(el('div', { class: 'git-changes-empty roadmap-list-empty' }, hint))
      return
    }
    const categoryOrder: readonly (RoadmapCategory | 'uncategorized')[] = [
      ...ROADMAP_CATEGORIES,
      'uncategorized',
    ]
    for (const category of categoryOrder) {
      const categoryItems = visible.filter((item) => itemCategory(item) === category)
      if (categoryItems.length === 0) continue
      const group = el('section', {
        class: `roadmap-category-group is-${category}`,
        'data-category': category,
      })
      const groupItems = el('div', { class: 'roadmap-category-items' })
      if (categoryItems.length > 1) {
        const collapsed = collapsedCategories.has(category)
        groupItems.hidden = collapsed
        const label =
          category === 'uncategorized' ? 'Uncategorized' : roadmapCategoryLabel(category)
        const header = el(
          'button',
          {
            type: 'button',
            class: 'roadmap-category-header',
            'aria-expanded': collapsed ? 'false' : 'true',
          },
          el('span', { class: 'roadmap-category-chevron' }, collapsed ? '›' : '⌄'),
          el('span', { class: 'roadmap-category-header-label' }, label),
          el('span', { class: 'roadmap-category-count' }, String(categoryItems.length)),
        )
        header.addEventListener('click', () => {
          if (collapsedCategories.has(category)) collapsedCategories.delete(category)
          else collapsedCategories.add(category)
          renderList()
        })
        group.append(header)
      }
      for (const item of categoryItems) {
        const isSelected = item.id === selectedId
      const status = itemStatus(item)
      const row = el('button', {
        type: 'button',
        class: [
          'git-change-row',
          'memories-row',
          'roadmap-row',
          isSelected ? 'is-selected' : '',
          status === 'done' ? 'is-done' : '',
          status === 'archived' ? 'is-archived' : '',
        ]
          .filter(Boolean)
          .join(' '),
      })
      const main = el('div', { class: 'memories-row-main' })
      // Trailing indicators only — title leads; default `ready` is silent.
      const meta = el('div', { class: 'roadmap-row-meta' })
      if (LIST_STATUS_BADGES.has(status)) {
        meta.append(el('span', { class: `roadmap-status-badge is-${status}` }, status))
      }
      const categoryBadge = item.fields['category']
      if (isRoadmapCategory(categoryBadge)) {
        meta.append(
          el(
            'span',
            {
              class: `roadmap-category-badge is-${categoryBadge}`,
              title: 'Roadmap category',
            },
            categoryBadge,
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
      const review = item.fields['reviewVerdict']
      if (isRoadmapReviewVerdict(review)) {
        meta.append(
          el(
            'span',
            {
              class: `roadmap-review-badge is-${review}`,
              title: 'Model verdict: has this roadmap item been resolved?',
            },
            `review: ${review}`,
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
      // Items whose started thread is still around get an icon that jumps
      // straight back to it (tracked via the `thread` field on Start thread).
      const trackedThread = getThreadById(store, itemThreadId(item))
      if (trackedThread) {
        const threadChip = el('span', {
          class: 'roadmap-thread-chip',
          role: 'link',
          tabindex: '0',
          title: `Reopen thread "${trackedThread.title}"`,
          'aria-label': `Reopen thread "${trackedThread.title}"`,
        })
        threadChip.append(attachmentIcon('thread', 'ui-icon roadmap-thread-chip-icon'))
        threadChip.addEventListener('click', (e) => {
          // The row itself selects the item; the chip only reopens the thread.
          e.stopPropagation()
          switchThread(store, trackedThread.id)
          getPromptAttachmentHandlers()?.focusComposer?.()
        })
        threadChip.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          switchThread(store, trackedThread.id)
          getPromptAttachmentHandlers()?.focusComposer?.()
        })
        meta.append(threadChip)
      }
      // Complexity follows the attachment and thread indicators so the compact
      // relationship shortcuts stay closest to the title.
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

      // One-click status flip without opening the editor: check marks a live
      // item done, refresh reopens a done one. Hidden until row hover/focus so
      // the list stays quiet at rest. Archived items keep the editor-only flow.
      // A span with role=button, like the issue chip — rows are <button>s and
      // buttons cannot nest.
      if (status !== 'archived') {
        const isDone = status === 'done'
        const toggle = el('span', {
          class: 'roadmap-done-toggle',
          role: 'button',
          tabindex: '0',
          title: isDone ? 'Reopen (set ready)' : 'Mark done',
          'aria-label': isDone ? 'Reopen roadmap item' : 'Mark roadmap item done',
        })
        toggle.append(
          isDone
            ? refreshIcon('ui-icon roadmap-done-toggle-icon')
            : checkIcon('ui-icon roadmap-done-toggle-icon'),
        )
        toggle.addEventListener('click', (e) => {
          // The row itself selects the item; the toggle only flips status.
          e.stopPropagation()
          void setStatus(item, isDone ? 'ready' : 'done')
        })
        toggle.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
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
        if (reviewing || importing) return
        if (item.id === selectedId) return
        leaveCurrentEditor()
        cancelResolutionCheckUi()
        selectedId = item.id
        creating = false
        renderList()
        renderEditor()
        void maybeAutoCheckResolution(item)
      })
        groupItems.append(row)
      }
      group.append(groupItems)
      listBody.append(group)
    }
    // A partly clipped row stays put. Only selections wholly above or below
    // the viewport are brought back, which avoids fighting deliberate scroll.
    const selectedRow = listBody.querySelector('.is-selected')
    if (selectedRow) {
      const rowRect = selectedRow.getBoundingClientRect()
      const listRect = listBody.getBoundingClientRect()
      const hasLayout = listRect.height > 0 && rowRect.height > 0
      if (hasLayout && (rowRect.bottom <= listRect.top || rowRect.top >= listRect.bottom)) {
        selectedRow.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  // `preserveDirty` is passed only by background store-event refreshes so an
  // in-progress edit/draft is not clobbered. Explicit actions (save, delete,
  // workspace change) refresh without it so the editor renders fresh.
  async function refresh(opts?: { preserveDirty?: boolean }): Promise<void> {
    const token = ++loadToken
    // Only flip on the loading state (and repaint) when the list is currently
    // empty — a background refresh of an already-populated list shouldn't
    // flash "Loading…" over the existing rows.
    if (items.length === 0 && !loading) {
      loading = true
      renderList()
    }
    let next: RoadmapItem[]
    try {
      next = await api.roadmap.list()
    } catch {
      next = []
    }
    if (token !== loadToken) return
    loading = false
    items = next
    // Drop a selection whose item vanished (deleted elsewhere), but keep an
    // in-progress new-item form open. During review/import the viewer column
    // is owned by the overlay — don't restore a list selection on top of it.
    if (
      !reviewing &&
      !importing &&
      selectedId &&
      !items.some((m) => m.id === selectedId) &&
      !creating
    ) {
      selectedId = null
    }
    renderList()
    if (reviewing) renderReviewResults()
    renderEditor(opts)
  }

  function startNew(): void {
    leaveCurrentEditor()
    cancelResolutionCheckUi()
    selectedId = null
    creating = true
    importing = false
    renderList()
    renderEditor()
    promptInput.focus()
    // Scroll the new-item form into view so it's visible immediately.
    promptInput.scrollIntoView({ block: 'nearest' })
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
          firstNonEmptyString(notes),
          firstNonEmptyString(issue),
          addAttachments.length > 0 ? addAttachments : undefined,
        )
        selectedId = created.id
        const category = isRoadmapCategory(categorySelect.value) ? categorySelect.value : ''
        if (category) await api.roadmap.setCategory(created.id, category)
        creating = false
        editorDrafts.delete(NEW_ITEM_DRAFT_KEY)
      } else {
        const updated = await api.roadmap.update(
          selectedId,
          prompt,
          firstNonEmptyString(notes),
          isRoadmapStatus(statusSelect.value) ? statusSelect.value : 'ready',
          firstNonEmptyString(issue),
          addAttachments.length > 0 ? addAttachments : undefined,
          removeIds.length > 0 ? removeIds : undefined,
        )
        if (!updated) {
          showError('This roadmap item no longer exists.')
          selectedId = null
          creating = false
        } else {
          const storedCategory =
            updated.fields['categoryManual'] && isRoadmapCategory(updated.fields['category'])
              ? updated.fields['category']
              : ''
          const category = isRoadmapCategory(categorySelect.value) ? categorySelect.value : ''
          if (category !== storedCategory) await api.roadmap.setCategory(updated.id, category)
        }
      }
      if (selectedId) editorDrafts.delete(selectedId)
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not save roadmap item.')
    } finally {
      saveBtn.disabled = false
    }
  }

  async function remove(): Promise<void> {
    if (!selectedId) return
    const id = selectedId
    const item = items.find((m) => m.id === id)
    if (
      !(await showConfirmDialog({
        message: `Delete roadmap item "${nonEmptyStringOr(item?.title, 'untitled')}"?`,
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return
    }
    deleteBtn.disabled = true
    try {
      await api.roadmap.delete(id)
      editorDrafts.delete(id)
      if (reviewPeekId === id) {
        reviewPeekId = null
      }
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
    const key = currentDraftKey()
    if (key) editorDrafts.delete(key)
    cancelResolutionCheckUi()
    if (reviewing && reviewPeekId) {
      returnToReview(false)
      return
    }
    creating = false
    selectedId = null
    renderList()
    renderEditor()
  }

  /** Drop in-flight deep-check UI when navigating away from the item under check. */
  function cancelResolutionCheckUi(): void {
    if (!resolutionCheckInFlight) return
    resolutionCheckToken++
    resolutionCheckInFlight = false
    resolutionCheckItemId = null
    resolutionBtn.disabled = false
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

  async function ensureCheckpoint(): Promise<{
    lastReviewAt: string | null
    lastAcknowledgedBulkRun: string | null
    pendingBulkRun: string | null
  }> {
    if (cachedCheckpoint !== undefined) return cachedCheckpoint
    cachedCheckpoint = await api.roadmap.lastReviewAt()
    return cachedCheckpoint
  }

  async function checkResolution(): Promise<void> {
    if (!selectedId) return
    const token = ++resolutionCheckToken
    const itemId = selectedId
    resolutionCheckItemId = itemId
    resolutionBtn.disabled = true
    resolutionCheckInFlight = true
    reviewResult.hidden = false
    reviewResultMeta.textContent = 'Deep resolution check…'
    reviewResultBody.hidden = true
    reviewResultBody.replaceChildren()
    try {
      await api.roadmap.reviewItemDeep(itemId)
      if (token !== resolutionCheckToken) return
      resolutionCheckInFlight = false
      resolutionCheckItemId = null
      await refresh({ preserveDirty: true })
    } catch (err) {
      if (token !== resolutionCheckToken) return
      reviewResultMeta.textContent = ipcErrorMessage(err, 'Resolution check failed.')
      reviewResultBody.hidden = true
      reviewResultBody.replaceChildren()
    } finally {
      if (token === resolutionCheckToken) {
        resolutionCheckInFlight = false
        resolutionCheckItemId = null
        resolutionBtn.disabled = false
      }
    }
  }

  /** Auto deep-check when opening an item whose bulk verdict is stale. */
  async function maybeAutoCheckResolution(item: RoadmapItem): Promise<void> {
    if (reviewing || resolutionCheckInFlight) return
    if (item.status === 'done' || item.status === 'archived') return
    const checkpoint = await ensureCheckpoint()
    if (!isReviewStale(item.fields, item.status, checkpoint)) return
    if (selectedId !== item.id) return
    await checkResolution()
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
    const threadId = createThread(store, draft)
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
    // Track the started thread on the item so it can be reopened from here
    // later. Best-effort: a failed stamp only costs the Reopen shortcut.
    if (selectedId) {
      void api.roadmap
        .setThread(selectedId, threadId)
        .then(() => refresh({ preserveDirty: true }))
        .catch(() => {})
    }
    handlers?.focusComposer?.()
  }

  // Switch back to the thread tracked on the selected item. The button only
  // shows while that thread exists, but the store can change between render
  // and click — fall back to an explanatory error rather than a dead click.
  function reopenThread(): void {
    const item = selectedId ? items.find((m) => m.id === selectedId) : null
    const threadId = item ? itemThreadId(item) : ''
    if (!threadId || !getThreadById(store, threadId)) {
      renderEditor({ preserveDirty: true })
      showError('That thread no longer exists — use Start thread to open a new one.')
      return
    }
    switchThread(store, threadId)
    getPromptAttachmentHandlers()?.focusComposer?.()
  }

  // --- import-from-issues flow -----------------------------------------------
  function issueAlreadyPinned(issue: OpenIssue): boolean {
    const short = `#${String(issue.number)}`
    const full = `${issue.owner}/${issue.repo}${short}`
    return items.some((i) => itemIssue(i) === short || itemIssue(i) === full)
  }

  function coverageFor(issue: OpenIssue): RoadmapIssueCoverageMatch | undefined {
    return issueCoverage.get(issue.number)
  }

  function renderImportList(): void {
    const selected = new Set(
      [...importList.querySelectorAll<HTMLInputElement>('.roadmap-import-check')]
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => Number(checkbox.dataset['number'])),
    )
    clear(importList)
    for (const issue of openIssues) {
      const pinned = issueAlreadyPinned(issue)
      const covered = !pinned ? coverageFor(issue) : undefined
      // Pin and likely coverage both block re-import; partial stays selectable
      // so the user can still add a tighter prompt when overlap is incomplete.
      const blocked = pinned || covered?.verdict === 'likely'
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'roadmap-import-check',
        'data-number': String(issue.number),
        disabled: blocked,
      })
      checkbox.checked = !blocked && selected.has(issue.number)
      const rowClass =
        'roadmap-import-row' +
        (pinned ? ' is-pinned' : '') +
        (covered?.verdict === 'likely' ? ' is-covered' : '')
      const label = el(
        'label',
        { class: rowClass },
        checkbox,
        el('span', { class: 'roadmap-import-title' }, `#${String(issue.number)} ${issue.title}`),
      )
      if (pinned) {
        label.append(el('span', { class: 'roadmap-import-coverage' }, 'already on roadmap'))
      } else if (covered) {
        const prefix = covered.verdict === 'likely' ? 'covered by' : 'maybe covered by'
        label.append(
          el(
            'span',
            {
              class: 'roadmap-import-coverage',
              title: `${prefix}: ${covered.itemTitle}`,
            },
            `${prefix}: ${covered.itemTitle}`,
          ),
        )
      }
      importList.append(label)
    }
  }

  function isCurrentImport(token: number): boolean {
    return importing && token === coverageToken
  }

  async function loadMoreOpenIssues(matchToken: number): Promise<void> {
    importLoadMoreBtn.disabled = true
    importStatus.textContent = openIssuePage === 0 ? 'Loading open issues…' : 'Loading more issues…'
    try {
      let issues: OpenIssue[] = []
      // REST issue pages can contain only pull requests, which the backend
      // removes. Skip empty raw pages so "Load more" always makes progress.
      do {
        const result = await api.roadmap.openIssues(openIssuePage + 1)
        if (!isCurrentImport(matchToken)) return
        openIssuePage++
        openIssueSlug = result.slug
        moreOpenIssues = result.hasMore
        issues = result.issues
      } while (issues.length === 0 && moreOpenIssues)

      openIssues.push(...issues)
      renderImportList()
      importLoadMoreBtn.hidden = !moreOpenIssues
      if (issues.length === 0) {
        importStatus.textContent = openIssues.length
          ? `Pick the issues to turn into roadmap prompts (${openIssueSlug}).`
          : `No open issues found in ${openIssueSlug}.`
        return
      }

      // Pin badges render immediately. Semantic coverage is bounded to this
      // page and merges into prior pages when the model answers.
      importStatus.textContent = `Checking existing roadmap coverage (${openIssueSlug})…`
      try {
        const matches = await api.roadmap.matchOpenIssues(
          issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body })),
        )
        if (!isCurrentImport(matchToken)) return
        for (const match of matches) issueCoverage.set(match.issueNumber, match)
        renderImportList()
      } catch {
        // Coverage is advisory — a failed page must not strand the picker or
        // prevent the user from loading the next page.
      }
      if (!isCurrentImport(matchToken)) return
      importStatus.textContent = `Pick the issues to turn into roadmap prompts (${openIssueSlug}).`
    } catch (err) {
      if (!isCurrentImport(matchToken)) return
      importStatus.textContent = ipcErrorMessage(err, 'Could not list open issues.')
    } finally {
      if (isCurrentImport(matchToken)) {
        importLoadMoreBtn.disabled = false
        importLoadMoreBtn.hidden = !moreOpenIssues
      }
    }
  }

  function startImport(): void {
    cancelResolutionCheckUi()
    importing = true
    reviewing = false
    creating = false
    selectedId = null
    openIssues = []
    openIssuePage = 0
    openIssueSlug = ''
    moreOpenIssues = false
    issueCoverage = new Map()
    const matchToken = ++coverageToken
    clear(importList)
    importLoadMoreBtn.hidden = true
    importConfirmBtn.disabled = false
    importStatus.textContent = 'Loading open issues…'
    renderList()
    renderEditor()
    void loadMoreOpenIssues(matchToken)
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
    coverageToken++
    issueCoverage = new Map()
    renderEditor()
  }

  function reviewSuggestArchive(verdict: ReviewItemResult['verdict']): boolean {
    return verdict === 'resolved' || verdict === 'likely'
  }

  async function setItemStatusFromReview(id: string, status: RoadmapStatus): Promise<boolean> {
    try {
      const updated = await api.roadmap.setStatus(id, status)
      if (!updated) return false
      reviewApplied.set(id, status)
      await refresh({ preserveDirty: true })
      renderReviewResults()
      return true
    } catch (err) {
      reviewStatus.textContent = ipcErrorMessage(err, 'Could not update roadmap item.')
      return false
    }
  }

  function openReviewItem(id: string): void {
    if (id !== selectedId) leaveCurrentEditor()
    cancelResolutionCheckUi()
    selectedId = id
    creating = false
    reviewPeekId = reviewing ? id : null
    renderList()
    renderEditor()
  }

  function returnToReview(saveDraft = true): void {
    if (saveDraft) leaveCurrentEditor()
    cancelResolutionCheckUi()
    reviewPeekId = null
    selectedId = null
    renderList()
    renderEditor()
    if (reviewing) renderReviewResults()
  }

  function syncReviewActionVisibility(): void {
    reviewStopBtn.hidden = !reviewInFlight
    reviewStopBtn.disabled = false
    if (reviewInFlight) {
      reviewMarkResolvedBtn.hidden = true
      reviewArchiveResolvedBtn.hidden = true
    }
  }

  function renderReviewResults(): void {
    clear(reviewList)
    let pendingResolved = 0
    for (const result of reviewResults) {
      const item = items.find((i) => i.id === result.id)
      const title = nonEmptyStringOr(item?.title, '(untitled)')
      const applied = reviewApplied.get(result.id)
      const row = el('div', {
        class: `roadmap-review-row${applied ? ' is-applied' : ''}`,
      })
      const header = el('div', { class: 'roadmap-review-row-header' })
      header.append(
        el('div', { class: 'roadmap-review-row-title' }, title),
        el(
          'span',
          { class: `roadmap-review-badge is-${result.verdict}` },
          `review: ${result.verdict}`,
        ),
      )
      if (applied) {
        header.append(el('span', { class: 'roadmap-review-applied-badge' }, `status: ${applied}`))
      }
      row.append(header)
      if (result.detail) {
        const detailEl = el('div', {
          class: 'roadmap-review-row-detail message-text streaming-markdown',
        })
        detailEl.innerHTML = renderMarkdown(reviewDetailMarkdown(result.detail))
        row.append(detailEl)
      }
      const evidence: string[] = []
      if (result.pinnedIssue) {
        evidence.push(
          `Pinned ${result.pinnedIssue.ref} [${result.pinnedIssue.state}]: ${result.pinnedIssue.title}`,
        )
      }
      for (const linked of result.linkedIssues) {
        evidence.push(`Linked #${String(linked.number)} [${linked.state}]: ${linked.title}`)
      }
      if (evidence.length > 0) {
        row.append(
          el('div', { class: 'memories-meta roadmap-review-evidence' }, evidence.join(' · ')),
        )
      }
      const actions = el('div', { class: 'memories-actions roadmap-review-row-actions' })
      const openBtn = el(
        'button',
        { type: 'button', class: 'memories-btn roadmap-review-open' },
        'Open',
      )
      openBtn.addEventListener('click', () => {
        openReviewItem(result.id)
      })
      actions.append(openBtn)
      if (!applied && reviewSuggestArchive(result.verdict)) {
        pendingResolved++
        const doneBtn = el(
          'button',
          { type: 'button', class: 'memories-btn memories-btn-primary roadmap-review-mark-done' },
          'Mark done',
        )
        doneBtn.addEventListener('click', () => {
          void setItemStatusFromReview(result.id, 'done')
        })
        const archiveBtn = el(
          'button',
          { type: 'button', class: 'memories-btn roadmap-review-archive' },
          'Archive',
        )
        archiveBtn.addEventListener('click', () => {
          void setItemStatusFromReview(result.id, 'archived')
        })
        actions.append(doneBtn, archiveBtn)
      }
      row.append(actions)
      reviewList.append(row)
    }
    const hasBulk = pendingResolved > 0 && !reviewInFlight
    reviewMarkResolvedBtn.hidden = !hasBulk
    reviewArchiveResolvedBtn.hidden = !hasBulk
    reviewMarkResolvedBtn.disabled = !hasBulk
    reviewArchiveResolvedBtn.disabled = !hasBulk
  }

  function stopReview(): void {
    if (!reviewInFlight) return
    reviewInFlight = false
    reviewStopBtn.disabled = true
    reviewStatus.textContent = 'Stopping review…'
    reviewRunToken++
    reviewPeekId = null
    selectedId = null
    const runId = bulkRunId
    bulkRunId = null
    if (runId) {
      void api.roadmap.abortReview(runId).then(() => {
        cachedCheckpoint = undefined
      })
    }
    reviewStatus.textContent =
      reviewResults.length > 0
        ? `Review stopped — ${String(reviewResults.length)} item(s) judged so far. Close when finished.`
        : 'Review stopped.'
    syncReviewActionVisibility()
    renderList()
    renderEditor()
    if (reviewing) renderReviewResults()
  }

  async function applyReviewBulkStatus(status: 'done' | 'archived'): Promise<void> {
    const label = status === 'done' ? 'mark done' : 'archive'
    const targets = reviewResults.filter(
      (r) => reviewSuggestArchive(r.verdict) && !reviewApplied.has(r.id),
    )
    if (targets.length === 0) {
      reviewStatus.textContent = `Nothing left to ${label}.`
      return
    }
    if (
      !confirm(
        `${status === 'done' ? 'Mark' : 'Archive'} ${String(targets.length)} item(s) judged resolved or likely?`,
      )
    ) {
      return
    }
    reviewMarkResolvedBtn.disabled = true
    reviewArchiveResolvedBtn.disabled = true
    let applied = 0
    for (const [index, result] of targets.entries()) {
      reviewStatus.textContent = `${status === 'done' ? 'Marking done' : 'Archiving'} ${String(index + 1)} of ${String(targets.length)}…`
      if (await setItemStatusFromReview(result.id, status)) applied++
    }
    reviewStatus.textContent = `Updated ${String(applied)} item(s).`
    reviewMarkResolvedBtn.disabled = false
    reviewArchiveResolvedBtn.disabled = false
  }

  async function startReview(): Promise<void> {
    cancelResolutionCheckUi()
    const runToken = ++reviewRunToken
    reviewing = true
    reviewPeekId = null
    bulkReviewFinished = false
    reviewInFlight = false
    bulkRunId = null
    importing = false
    creating = false
    selectedId = null
    reviewResults = []
    reviewApplied.clear()
    clear(reviewList)
    reviewStatus.textContent = 'Preparing review…'
    reviewBtn.disabled = true
    reviewInFlight = true
    syncReviewActionVisibility()
    renderList()
    renderEditor()
    try {
      const prepared = await api.roadmap.prepareReview()
      if (runToken !== reviewRunToken) {
        void api.roadmap.abortReview(prepared.runId)
        return
      }
      bulkRunId = prepared.runId
      if (prepared.items.length === 0) {
        reviewStatus.textContent = 'No active roadmap items to review.'
        return
      }
      const sinceLabel = prepared.since
        ? `since ${knowledgeDate(prepared.since)}`
        : 'first review (recent commits)'
      reviewStatus.textContent = `Reviewing ${String(prepared.items.length)} item(s); commits ${sinceLabel}.`
      for (const [index, item] of prepared.items.entries()) {
        reviewStatus.textContent = `Reviewing ${String(index + 1)} of ${String(prepared.items.length)}: ${item.title}…`
        const result = await api.roadmap.reviewItem(item.id, prepared.commits, prepared.runId)
        if (runToken !== reviewRunToken) return
        reviewResults.push(result)
        renderReviewResults()
        await refresh({ preserveDirty: true })
      }
      bulkReviewFinished = true
      reviewStatus.textContent = `Review complete — ${String(reviewResults.length)} item(s) judged. Use the row actions to mark done, archive, or open an item. Close when finished to advance the commit checkpoint.`
      syncReviewActionVisibility()
      renderReviewResults()
    } catch (err) {
      reviewStatus.textContent = ipcErrorMessage(err, 'Roadmap review failed.')
    } finally {
      reviewInFlight = false
      reviewBtn.disabled = false
      syncReviewActionVisibility()
    }
  }

  function closeReview(): void {
    reviewRunToken++
    reviewPeekId = null
    if (bulkReviewFinished && bulkRunId) {
      void api.roadmap.completeReview(bulkRunId).then(() => {
        cachedCheckpoint = undefined
      })
    } else if (bulkRunId) {
      void api.roadmap.abortReview(bulkRunId).then(() => {
        cachedCheckpoint = undefined
      })
    }
    reviewing = false
    bulkReviewFinished = false
    reviewInFlight = false
    bulkRunId = null
    renderEditor()
  }

  importBtn.addEventListener('click', startImport)
  reviewBtn.addEventListener('click', () => void startReview())
  reviewBackBtn.addEventListener('click', () => {
    returnToReview()
  })
  reviewStopBtn.addEventListener('click', stopReview)
  reviewCloseBtn.addEventListener('click', closeReview)
  reviewMarkResolvedBtn.addEventListener('click', () => void applyReviewBulkStatus('done'))
  reviewArchiveResolvedBtn.addEventListener('click', () => void applyReviewBulkStatus('archived'))
  importLoadMoreBtn.addEventListener('click', () => void loadMoreOpenIssues(coverageToken))
  importConfirmBtn.addEventListener('click', () => void confirmImport())
  importCancelBtn.addEventListener('click', cancelImport)

  newBtn.addEventListener('click', startNew)
  refreshBtn.addEventListener('click', () => void refresh())
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void save()
  })
  // Cmd/Ctrl+Enter to save from any input field.
  form.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
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
    if (!form.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null))
      form.classList.remove('is-drop-target')
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
  reopenBtn.addEventListener('click', reopenThread)
  fitBtn.addEventListener('click', () => void checkFit())
  resolutionBtn.addEventListener('click', () => void checkResolution())
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
      if (itemId !== selectedId) leaveCurrentEditor()
      selectedId = itemId
      creating = false
      importing = false
      void refresh()
    }),
    // Thread create/delete changes whether a tracked thread can be reopened;
    // re-render from the already-loaded items (no IPC round-trip needed).
    store.on('threads_changed', () => {
      if (!roadmapModeActive(store)) return
      renderList()
      renderEditor({ preserveDirty: true })
    }),
    store.on('workspace_changed', () => {
      // The roadmap is per-project; drop the previous workspace's selection.
      cancelResolutionCheckUi()
      selectedId = null
      creating = false
      importing = false
      reviewing = false
      items = []
      editorDrafts.clear()
      autoSaveToken.clear()
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

  const unregisterPopoutSeed = registerPopoutSeedHandlers('roadmap', {
    capture: () => ({ selectedId }),
    apply: (seed) => {
      if (!seed || typeof seed !== 'object') return
      const next = seed as { selectedId?: string | null }
      if (next.selectedId) store.emit('roadmap_reveal', next.selectedId)
    },
  })

  return () => {
    document.removeEventListener('click', closeFilterOnOutsideClick)
    unregisterPopoutSeed()
    unsubs.forEach((u) => {
      u()
    })
  }
}
