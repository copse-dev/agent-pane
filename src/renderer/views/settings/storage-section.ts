import { createStorageMaintenancePanel } from '../storage-maintenance-panel.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { WorktreeInventoryEntry } from '@shared/types/worktree.ts'
import { errorMessage } from '@shared/errors.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { el, qsRequired } from '../../dom/helpers.ts'
import { switchProjectThread } from '../../controller/projects.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import { makeSourceRow } from './source-row.ts'

export interface StorageSection {
  refresh(status?: string, force?: boolean): Promise<void>
  reset(): void
  invalidate(): void
}
export function createStorageSection(
  overlay: HTMLElement,
  api: ApiClient,
  store: AppStore,
  closeSettingsDialog: () => void,
): StorageSection {
  const maintenance = createStorageMaintenancePanel(api)
  qsRequired(overlay, '.settings-section[data-section="storage"]').append(maintenance.element)

  function fillSourceList(selector: string, rows: HTMLElement[], emptyText: string): void {
    const list = qsRequired(overlay, selector)
    list.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'sources-empty'
      empty.textContent = emptyText
      list.append(empty)
      return
    }
    for (const row of rows) list.append(row)
  }

  /** Coarse "when", accurate enough for a list that is scanned, not audited. */
  function relativeTime(value: number): string {
    const elapsed = Date.now() - value
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    if (elapsed < 0) return 'just now'
    if (elapsed < minute) return 'just now'
    if (elapsed < hour) return `${String(Math.floor(elapsed / minute))}m ago`
    if (elapsed < day) return `${String(Math.floor(elapsed / hour))}h ago`
    if (elapsed < 30 * day) return `${String(Math.floor(elapsed / day))}d ago`
    return new Date(value).toLocaleDateString()
  }

  /**
   * What a worktree is *for*, in one word. A checkout with a live turn in it
   * cannot be deleted at all; one whose thread has gone (or stopped pointing at
   * it) is the case worth reclaiming, so both are said plainly rather than left
   * for the user to infer from the detail line.
   */
  function worktreeBadge(entry: WorktreeInventoryEntry): {
    text: string
    className: string | undefined
  } {
    if (entry.usage?.running) return { text: 'in use', className: undefined }
    if (!entry.managed) return { text: 'external', className: undefined }
    if (!entry.usage) return { text: 'orphaned', className: 'sources-badge-warning' }
    if (!entry.usage.linked) return { text: 'released', className: 'sources-badge-warning' }
    if (entry.usage.archived) return { text: 'archived thread', className: undefined }
    return { text: 'thread', className: undefined }
  }

  function worktreeDetail(entry: WorktreeInventoryEntry): string {
    const bits: string[] = []
    if (entry.usage) bits.push(`Thread “${entry.usage.title}”`)
    else if (entry.managed) bits.push('No thread on record')
    else bits.push('Created outside Copse')
    if (entry.lastUsedAt !== null) bits.push(`last used ${relativeTime(entry.lastUsedAt)}`)
    if (entry.createdAt !== null) bits.push(`created ${relativeTime(entry.createdAt)}`)
    return bits.join(' · ')
  }

  /** The row, plus the slot its measured size lands in once `worktrees:size` answers. */
  function makeWorktreeRow(
    projectId: string,
    entry: WorktreeInventoryEntry,
  ): {
    row: HTMLElement
    size: HTMLElement
  } {
    const badge = worktreeBadge(entry)
    const extraBadges: Array<{ text: string; className: string }> = []
    if (entry.changedCount !== null && entry.changedCount > 0) {
      extraBadges.push({
        text: `${String(entry.changedCount)} uncommitted`,
        className: 'sources-badge-warning sources-worktree-changes',
      })
    }
    if (entry.merged === false) {
      extraBadges.push({ text: 'unmerged', className: 'sources-badge-warning' })
    }
    if (entry.detached) {
      extraBadges.push({ text: 'detached HEAD', className: 'sources-badge-unsupported' })
    }
    if (entry.locked !== null) {
      extraBadges.push({ text: 'locked', className: 'sources-badge-unsupported' })
    }

    const row = makeSourceRow(entry.branch ?? entry.path, badge.text, worktreeDetail(entry), {
      ...(badge.className ? { badgeClass: badge.className } : {}),
      extraBadges,
      titleAttr: entry.path,
      hoverDetail: entry.path,
    })
    row.dataset['worktreePath'] = entry.path
    const select = document.createElement('input')
    select.type = 'checkbox'
    select.className = 'sources-worktree-select'
    select.setAttribute('aria-label', `Select worktree ${entry.branch ?? entry.path}`)
    select.disabled = Boolean(entry.usage?.running)
    select.addEventListener('change', () => {
      if (select.checked) selectedWorktrees.add(entry.path)
      else selectedWorktrees.delete(entry.path)
      syncWorktreeSelection()
    })
    row.querySelector('.sources-row-header')?.prepend(select)

    // A known owner turns the status badge into the shortest possible route
    // back to its conversation. This also handles a Storage project other than
    // the active one: switchProjectThread loads that project before selecting it.
    if (entry.usage) {
      const usage = entry.usage
      const badgeEl = row.querySelector<HTMLElement>('.sources-badge')
      if (badgeEl) {
        const threadBtn = document.createElement('button')
        threadBtn.type = 'button'
        threadBtn.className = badgeEl.className
        threadBtn.classList.add('sources-worktree-thread-btn')
        threadBtn.textContent = badge.text
        threadBtn.title = `Open thread “${usage.title}”`
        threadBtn.setAttribute('aria-label', `Open thread ${usage.title}`)
        threadBtn.addEventListener('click', () => {
          switchProjectThread(store, api, projectId, usage.threadId)
          closeSettingsDialog()
        })
        badgeEl.replaceWith(threadBtn)
      }
    }

    // Size arrives from a second call per row (`worktrees:size` walks the whole
    // checkout), so the row reserves its slot rather than reflowing later.
    const size = document.createElement('span')
    size.className = 'sources-worktree-size'
    size.textContent = 'sizing…'
    size.dataset['sizeState'] = 'pending'
    row.querySelector('.sources-row-detail')?.append(' · ', size)

    const terminalBtn = document.createElement('button')
    terminalBtn.type = 'button'
    terminalBtn.className = 'sources-worktree-action-btn sources-worktree-terminal-btn'
    terminalBtn.textContent = 'Terminal'
    terminalBtn.title = 'Open the system terminal in this checkout'
    terminalBtn.addEventListener('click', () => {
      void openWorktreeTerminal(projectId, entry, terminalBtn)
    })

    const cleanupBtn = document.createElement('button')
    cleanupBtn.type = 'button'
    cleanupBtn.className = 'sources-worktree-action-btn sources-worktree-cleanup-btn'
    cleanupBtn.textContent = 'Clean up…'
    if (entry.usage?.running) {
      cleanupBtn.disabled = true
      cleanupBtn.title = 'Package directories cannot be removed while an agent turn is running'
    } else {
      cleanupBtn.title = 'Remove ignored package-manager directories from this checkout'
    }
    cleanupBtn.addEventListener('click', () => {
      void runWorktreeAction(() => cleanupWorktreePackages(projectId, [entry]))
    })

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'sources-worktree-action-btn sources-worktree-delete-btn'
    removeBtn.textContent = 'Delete'
    if (entry.usage?.running) {
      removeBtn.disabled = true
      removeBtn.title = 'An agent turn is running in this worktree'
    } else {
      removeBtn.title = 'Remove this linked checkout from disk'
    }
    removeBtn.addEventListener('click', () => {
      void runWorktreeAction(() => removeWorktree(projectId, entry))
    })
    row.querySelector('.sources-row-header')?.append(terminalBtn, cleanupBtn, removeBtn)
    return { row, size }
  }

  async function openWorktreeTerminal(
    projectId: string,
    entry: WorktreeInventoryEntry,
    button: HTMLButtonElement,
  ): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    button.disabled = true
    statusEl.textContent = 'Opening terminal…'
    try {
      await api.worktrees.openTerminal(projectId, entry.path)
      statusEl.textContent = `Opened a terminal in ${entry.branch ?? entry.path}.`
    } catch (error) {
      statusEl.textContent = errorMessage(error)
    } finally {
      button.disabled = false
    }
  }

  async function cleanupWorktreePackages(
    projectId: string,
    entries: WorktreeInventoryEntry[],
  ): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    const problems: string[] = []
    const bulkButton = qsRequired<HTMLButtonElement>(overlay, '#sources-worktrees-cleanup')

    function setEntryPhase(
      entry: WorktreeInventoryEntry,
      phase: 'checking' | 'pending' | 'cleaning' | 'cleaned' | 'failed' | null,
    ): void {
      const target = worktreeRows.get(entry.path)
      if (!target) return
      const button = qsRequired<HTMLButtonElement>(target.row, '.sources-worktree-cleanup-btn')
      if (phase === null) {
        delete target.row.dataset['cleanupState']
        target.row.removeAttribute('aria-busy')
        button.textContent = 'Clean up…'
        button.removeAttribute('aria-busy')
        return
      }
      target.row.dataset['cleanupState'] = phase
      const busy = phase === 'checking' || phase === 'pending' || phase === 'cleaning'
      if (busy) target.row.setAttribute('aria-busy', 'true')
      else target.row.removeAttribute('aria-busy')
      button.textContent =
        phase === 'checking'
          ? 'Checking…'
          : phase === 'pending'
            ? 'Pending…'
            : phase === 'cleaning'
              ? 'Cleaning…'
              : phase === 'cleaned'
                ? 'Cleaned'
                : 'Failed'
      if (busy) button.setAttribute('aria-busy', 'true')
      else button.removeAttribute('aria-busy')
    }

    function setBulkLabel(text: string, busy: boolean): void {
      bulkButton.textContent = text
      if (busy) bulkButton.setAttribute('aria-busy', 'true')
      else bulkButton.removeAttribute('aria-busy')
    }

    for (const entry of entries) setEntryPhase(entry, 'checking')
    setBulkLabel(entries.length === 1 ? 'Checking…' : 'Preparing…', true)
    statusEl.textContent =
      entries.length === 1
        ? 'Looking for package directories…'
        : `Preparing cleanup for ${String(entries.length)} worktrees…`

    const cleanupState = { started: false }
    const performCleanup = async (
      setConfirmProgress: (label: string) => void,
      signal: AbortSignal,
    ): Promise<void> => {
      cleanupState.started = true
      signal.addEventListener(
        'abort',
        () => {
          setBulkLabel('Stopping…', true)
          statusEl.textContent = 'Stopping cleanup after the current worktree finishes…'
        },
        { once: true },
      )
      for (const entry of entries) setEntryPhase(entry, 'pending')
      let cleaned = 0
      let reclaimed = 0
      let truncated = false
      for (const [index, entry] of entries.entries()) {
        if (signal.aborted) break
        setEntryPhase(entry, 'cleaning')
        const progress = `Cleaning ${String(index + 1)} of ${String(entries.length)}…`
        setBulkLabel(progress, true)
        setConfirmProgress(progress)
        statusEl.textContent = `Cleaning ${String(index + 1)} of ${String(entries.length)}: ${entry.branch ?? entry.path}…`
        try {
          const result = await api.worktrees.cleanupPackages(projectId, entry.path, true)
          if (result.status === 'blocked-running') {
            problems.push(`${entry.branch ?? entry.path}: an agent turn is running.`)
            setEntryPhase(entry, 'failed')
            continue
          }
          cleaned += result.directories.length
          reclaimed += result.bytes
          truncated ||= result.truncated
          if (result.directories.length > 0) selectedWorktrees.delete(entry.path)
          setEntryPhase(entry, 'cleaned')

          // Update cheap metadata now, but leave the full checkout measurement
          // pending until the batch is done. A cleaned checkout must never make
          // the next queued cleanup wait for another whole-tree walk.
          const target = worktreeRows.get(entry.path)
          if (target) {
            if (result.changedCount !== undefined) {
              entry.changedCount = result.changedCount
              target.row.querySelector('.sources-worktree-changes')?.remove()
              if (result.changedCount !== null && result.changedCount > 0) {
                const badge = document.createElement('span')
                badge.className =
                  'ui-badge sources-badge sources-badge-warning sources-worktree-changes'
                badge.textContent = `${String(result.changedCount)} uncommitted`
                target.row.querySelector('.sources-worktree-terminal-btn')?.before(badge)
              }
            }
            if (result.directories.length > 0) {
              target.size.textContent = 'sizing…'
              target.size.dataset['sizeState'] = 'pending'
            }
          }
        } catch (error) {
          problems.push(`${entry.branch ?? entry.path}: ${errorMessage(error)}`)
          setEntryPhase(entry, 'failed')
        }
      }
      const summary =
        cleaned > 0
          ? `Cleaned up ${String(cleaned)} director${cleaned === 1 ? 'y' : 'ies'} (${truncated ? 'at least ' : ''}${formatByteSize(reclaimed)}).`
          : signal.aborted
            ? 'No package directories were removed.'
            : 'No ignored package-manager directories found.'
      statusEl.textContent = [signal.aborted ? 'Cleanup stopped.' : '', summary, ...problems]
        .filter(Boolean)
        .join('\n')
    }

    try {
      // A single-row action keeps its detailed directory-and-size preview. For
      // a bulk action that preview was the expensive part: every checkout was
      // completely scanned before the user even saw a confirmation. Confirm
      // the selected scope immediately, then discover, measure, and remove one
      // checkout at a time so useful work begins straight away.
      if (entries.length === 1) {
        const entry = entries[0]
        if (!entry) return
        let preview
        try {
          preview = await api.worktrees.cleanupPackages(projectId, entry.path, false)
        } catch (error) {
          statusEl.textContent = errorMessage(error)
          setEntryPhase(entry, 'failed')
          return
        }
        if (preview.status === 'blocked-running') {
          statusEl.textContent = 'That worktree has an agent turn running in it.'
          setEntryPhase(entry, 'failed')
          return
        }
        if (preview.directories.length === 0) {
          statusEl.textContent = 'No ignored package-manager directories found.'
          setEntryPhase(entry, 'cleaned')
          return
        }
        const size = `${preview.truncated ? 'at least ' : ''}${formatByteSize(preview.bytes)}`
        const shown = preview.directories.slice(0, 12)
        const confirmed = await showConfirmDialog({
          message: `Remove ${String(preview.directories.length)} package director${preview.directories.length === 1 ? 'y' : 'ies'}?`,
          detail: el(
            'span',
            {},
            ...shown.flatMap((directory, index) => [
              ...(index > 0 ? ['\n'] : []),
              el('code', {}, directory.path),
            ]),
            ...(preview.directories.length > shown.length
              ? [`\n…and ${String(preview.directories.length - shown.length)} more`]
              : []),
            `\n\nThis will reclaim ${size}. Your package manager can recreate these directories.` +
              '\n\nCancel closes this dialog; the current worktree will finish cleaning.',
          ),
          confirmLabel: 'Clean up',
          confirmPendingLabel: 'Cleanup pending…',
          onConfirm: performCleanup,
          cancellable: true,
          danger: true,
        })
        if (!confirmed) {
          if (!cleanupState.started) statusEl.textContent = 'Kept.'
          return
        }
      } else {
        const confirmed = await showConfirmDialog({
          message: `Clean up package directories in ${String(entries.length)} worktrees?`,
          detail: el(
            'span',
            {},
            'Copse will find and remove ignored package-manager directories such as ',
            el('code', {}, 'node_modules'),
            ' and ',
            el('code', {}, '.venv'),
            '.\n\nCleanup starts immediately; reclaimed size is measured as each worktree completes.' +
              '\n\nYour package manager can recreate these directories.' +
              '\n\nCancel closes this dialog and stops after the current worktree finishes.',
          ),
          confirmLabel: 'Clean up',
          confirmPendingLabel: 'Cleanup pending…',
          onConfirm: performCleanup,
          cancellable: true,
          danger: true,
        })
        if (!confirmed) {
          if (!cleanupState.started) statusEl.textContent = 'Kept.'
          return
        }
      }
    } finally {
      for (const entry of entries) setEntryPhase(entry, null)
      setBulkLabel('Clean up…', false)
    }
  }

  const worktreeSizeRequests = new WeakMap<HTMLElement, number>()
  let worktreeSizeGeneration = 0
  let worktreeSizeFill: Promise<void> = Promise.resolve()

  /** Fill in each row's on-disk size, one checkout at a time so the walks don't pile up. */
  async function fillWorktreeSizes(
    projectId: string,
    targets: Array<{ entry: WorktreeInventoryEntry; size: HTMLElement }>,
    generation = worktreeSizeGeneration,
  ): Promise<void> {
    for (const target of targets) {
      if (generation !== worktreeSizeGeneration) return
      // A refresh mid-walk detaches the row it was measuring; dropping the
      // answer is right, and cheaper than cancelling the call.
      if (!target.size.isConnected) continue
      const request = (worktreeSizeRequests.get(target.size) ?? 0) + 1
      worktreeSizeRequests.set(target.size, request)
      target.size.dataset['sizeState'] = 'measuring'
      try {
        const size = await api.worktrees.size(projectId, target.entry.path)
        if (
          generation !== worktreeSizeGeneration ||
          worktreeSizeRequests.get(target.size) !== request
        )
          continue
        target.size.textContent = size.truncated
          ? `over ${formatByteSize(size.bytes)}`
          : formatByteSize(size.bytes)
        target.size.dataset['sizeState'] = 'ready'
      } catch {
        if (
          generation !== worktreeSizeGeneration ||
          worktreeSizeRequests.get(target.size) !== request
        )
          continue
        target.size.textContent = 'size unavailable'
        target.size.dataset['sizeState'] = 'unavailable'
      }
    }
  }

  /**
   * Delete one checkout. The first confirmation covers the directory; a second
   * one appears only when Git reports content that would be destroyed with it,
   * and lists what that content is — the state is re-read at delete time, so a
   * checkout the agent dirtied since the list rendered still stops here.
   */
  async function removeWorktree(
    projectId: string,
    entry: WorktreeInventoryEntry,
    alreadyConfirmed = false,
  ): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    const name = entry.branch ?? entry.path
    const consequences = [entry.path]
    if (entry.usage?.linked) {
      consequences.push(`Thread “${entry.usage.title}” will continue in the project checkout.`)
    }
    if (entry.merged === false && entry.branch) {
      consequences.push(`Branch ${entry.branch} has unmerged commits and will be kept.`)
    }
    const confirmed =
      alreadyConfirmed ||
      (await showConfirmDialog({
        message: `Delete worktree ${name}?`,
        detail: consequences.join('\n'),
        confirmLabel: 'Delete',
        danger: true,
      }))
    if (!confirmed) return

    statusEl.textContent = 'Deleting…'
    try {
      let result = await api.worktrees.remove(projectId, entry.path, false)
      if (result.status === 'blocked-dirty') {
        const shown = result.changed.slice(0, 10)
        const rest = result.changed.length - shown.length
        const forced = await showConfirmDialog({
          message: `Discard ${String(result.changed.length)} uncommitted file${
            result.changed.length === 1 ? '' : 's'
          }?`,
          detail: [name, ...shown, ...(rest > 0 ? [`…and ${String(rest)} more`] : [])].join('\n'),
          confirmLabel: 'Delete anyway',
          danger: true,
        })
        if (!forced) {
          statusEl.textContent = 'Kept.'
          return
        }
        result = await api.worktrees.remove(projectId, entry.path, true)
      }
      if (result.status === 'blocked-running') {
        statusEl.textContent = 'That worktree has an agent turn running in it.'
        return
      }
      if (result.status === 'blocked-dirty') {
        statusEl.textContent = 'Git still reports uncommitted work in that worktree.'
        return
      }
      worktreeRows.get(entry.path)?.row.remove()
      worktreeRows.delete(entry.path)
      selectedWorktrees.delete(entry.path)
      if (worktreeRows.size === 0) {
        fillSourceList(
          '#sources-worktrees-list',
          [],
          'No worktrees. Copse creates one when a thread runs in its own checkout.',
        )
      }
      statusEl.textContent = result.branchDeleted
        ? `Deleted ${name} and its branch.`
        : `Deleted ${name}.`
    } catch (error) {
      statusEl.textContent = errorMessage(error)
    }
  }

  const worktreeRows = new Map<
    string,
    { entry: WorktreeInventoryEntry; row: HTMLElement; size: HTMLElement }
  >()
  const selectedWorktrees = new Set<string>()
  let worktreeActionRunning = false

  function syncWorktreeSelection(): void {
    const eligible = [...worktreeRows.values()].filter(({ entry }) => !entry.usage?.running)
    qsRequired(overlay, '#sources-worktrees-selection').hidden = worktreeRows.size === 0
    const all = qsRequired<HTMLInputElement>(overlay, '#sources-worktrees-select-all')
    all.checked = eligible.length > 0 && selectedWorktrees.size === eligible.length
    all.indeterminate = selectedWorktrees.size > 0 && !all.checked
    all.disabled = worktreeActionRunning || eligible.length === 0
    qsRequired(overlay, '#sources-worktrees-selected-count').textContent =
      selectedWorktrees.size > 0 ? `${String(selectedWorktrees.size)} selected` : ''
    qsRequired(overlay, '#sources-worktrees-bulk-actions').hidden = selectedWorktrees.size === 0
    for (const { entry, row } of worktreeRows.values()) {
      const checkbox = qsRequired<HTMLInputElement>(row, '.sources-worktree-select')
      checkbox.checked = selectedWorktrees.has(entry.path)
      checkbox.disabled = worktreeActionRunning || Boolean(entry.usage?.running)
      for (const button of row.querySelectorAll<HTMLButtonElement>(
        '.sources-worktree-cleanup-btn, .sources-worktree-delete-btn',
      )) {
        button.disabled = checkbox.disabled
      }
    }
    for (const id of ['#sources-worktrees-cleanup', '#sources-worktrees-delete']) {
      qsRequired<HTMLButtonElement>(overlay, id).disabled = worktreeActionRunning
    }
    qsRequired<HTMLSelectElement>(overlay, '#storage-project-select').disabled =
      worktreeActionRunning || storageProjectId === null
  }

  async function runWorktreeAction(action: () => Promise<void>): Promise<void> {
    if (worktreeActionRunning) return
    worktreeActionRunning = true
    const interruptedSizeFill = worktreeSizeFill
    worktreeSizeGeneration += 1
    syncWorktreeSelection()
    try {
      await action()
    } finally {
      worktreeActionRunning = false
      syncWorktreeSelection()
      const projectId = storageProjectId
      const resumeSizes = async (): Promise<void> => {
        // IPC size walks cannot be cancelled once started. Let the one already
        // on disk settle, but its generation prevents it from launching the
        // rest of the queue or overwriting post-cleanup state.
        await interruptedSizeFill
        if (!projectId || projectId !== storageProjectId || worktreeActionRunning) return
        const pending = [...worktreeRows.values()].filter(
          ({ size }) =>
            size.dataset['sizeState'] !== 'ready' && size.dataset['sizeState'] !== 'unavailable',
        )
        if (pending.length > 0) await fillWorktreeSizes(projectId, pending)
      }
      worktreeSizeFill = resumeSizes()
      void worktreeSizeFill
    }
  }

  qsRequired<HTMLInputElement>(overlay, '#sources-worktrees-select-all').addEventListener(
    'change',
    (event) => {
      if (!(event.target instanceof HTMLInputElement)) return
      selectedWorktrees.clear()
      if (event.target.checked) {
        for (const { entry } of worktreeRows.values()) {
          if (!entry.usage?.running) selectedWorktrees.add(entry.path)
        }
      }
      syncWorktreeSelection()
    },
  )

  qsRequired(overlay, '#sources-worktrees-cleanup').addEventListener('click', () => {
    const projectId = storageProjectId
    if (!projectId) return
    const entries = [...worktreeRows.values()]
      .filter(({ entry }) => selectedWorktrees.has(entry.path))
      .map(({ entry }) => entry)
    if (entries.length > 0)
      void runWorktreeAction(() => cleanupWorktreePackages(projectId, entries))
  })

  qsRequired(overlay, '#sources-worktrees-delete').addEventListener('click', () => {
    const projectId = storageProjectId
    if (!projectId) return
    const targets = [...worktreeRows.values()].filter(({ entry }) =>
      selectedWorktrees.has(entry.path),
    )
    if (targets.length === 0) return
    void runWorktreeAction(async () => {
      const confirmed = await showConfirmDialog({
        message: `Delete ${String(targets.length)} worktree${targets.length === 1 ? '' : 's'}?`,
        detail: [
          ...targets.map(({ entry }) => entry.path),
          '',
          'Linked threads will continue in the project checkout. Fully merged branches will be deleted; unmerged branches will be kept.',
          'Worktrees with uncommitted files require a separate confirmation.',
        ].join('\n'),
        confirmLabel: 'Delete',
        danger: true,
      })
      if (!confirmed) return
      const outcomes: string[] = []
      const statusEl = qsRequired(overlay, '#sources-worktrees-status')
      for (const { entry } of targets) {
        await removeWorktree(projectId, entry, true)
        outcomes.push(`${entry.branch ?? entry.path}: ${statusEl.textContent}`)
      }
      statusEl.textContent = outcomes.join('\n')
    })
  })

  let storageProjectId: string | null = null
  let worktreeRefreshGeneration = 0

  function syncStorageProjectSelect(preferActiveProject = false): string | null {
    const select = qsRequired<HTMLSelectElement>(overlay, '#storage-project-select')
    const path = qsRequired(overlay, '#storage-project-path')
    const state = store.getState()
    const projects = state.projects.filter((project) => project.sshHost === undefined)
    const availableIds = new Set(projects.map((project) => project.id))
    const preferred = preferActiveProject ? state.activeProjectId : storageProjectId
    storageProjectId =
      (preferred && availableIds.has(preferred) ? preferred : null) ??
      (state.activeProjectId && availableIds.has(state.activeProjectId)
        ? state.activeProjectId
        : null) ??
      projects[0]?.id ??
      null

    select.replaceChildren()
    for (const project of projects) {
      const option = document.createElement('option')
      option.value = project.id
      option.textContent = `${project.name} — ${project.path}`
      option.title = project.path
      select.append(option)
    }
    select.disabled = projects.length === 0
    select.value = storageProjectId ?? ''
    const selected = projects.find((project) => project.id === storageProjectId)
    path.textContent = selected?.path ?? 'Open a local project to manage its storage.'
    return storageProjectId
  }

  /** Load inventory when opening Storage or choosing another project. */
  async function refreshWorktrees(status = '', preferActiveProject = false): Promise<void> {
    if (worktreeActionRunning) return
    worktreeSizeGeneration += 1
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    const projectId = syncStorageProjectSelect(preferActiveProject)
    worktreeRows.clear()
    selectedWorktrees.clear()
    fillSourceList('#sources-worktrees-list', [], 'Loading…')
    syncWorktreeSelection()
    const generation = ++worktreeRefreshGeneration
    if (!projectId) {
      fillSourceList('#sources-worktrees-list', [], 'Open a project to see its worktrees.')
      statusEl.textContent = ''
      return
    }
    try {
      const entries = await api.worktrees.list(projectId)
      if (generation !== worktreeRefreshGeneration || projectId !== storageProjectId) return
      const rendered = entries.map((entry) => ({ entry, ...makeWorktreeRow(projectId, entry) }))
      fillSourceList(
        '#sources-worktrees-list',
        rendered.map((item) => item.row),
        'No worktrees. Copse creates one when a thread runs in its own checkout.',
      )
      for (const target of rendered) worktreeRows.set(target.entry.path, target)
      syncWorktreeSelection()
      statusEl.textContent = status
      const sizeFill = fillWorktreeSizes(projectId, rendered)
      worktreeSizeFill = sizeFill
      await sizeFill
    } catch (error) {
      if (generation !== worktreeRefreshGeneration || projectId !== storageProjectId) return
      fillSourceList('#sources-worktrees-list', [], 'Could not list worktrees.')
      statusEl.textContent = errorMessage(error)
    }
  }

  const storageProjectSelect = qsRequired<HTMLSelectElement>(overlay, '#storage-project-select')
  storageProjectSelect.addEventListener('change', () => {
    storageProjectId = storageProjectSelect.value || null
    void refreshWorktrees()
  })

  return {
    refresh: async (status = '', preferActiveProject = false): Promise<void> => {
      await Promise.all([refreshWorktrees(status, preferActiveProject), maintenance.refresh()])
    },
    reset: (): void => {
      storageProjectId = null
    },
    invalidate: (): void => {
      worktreeRefreshGeneration += 1
      worktreeSizeGeneration += 1
    },
  }
}
