import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { el, clear } from '../dom/helpers.ts'
import { searchIcon } from '../dom/icons.ts'
import { openNewThread } from '@shared/store/thread-helpers.ts'
import { projectDisplayName, switchProject, switchProjectThread } from '../controller/projects.ts'
import { createNewProject } from '../controller/projects.ts'
import { openRightPanelWithWorkspace } from '../controller/panels.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { openKeyboardShortcutsDialog } from './keyboard-shortcuts-dialog.ts'
import { openFileSearchDialog } from './file-search-dialog.ts'
import { openConversationSearch } from './conversation-search.ts'

// Cmd/Ctrl+Shift+K "command palette" — a "filter all the things" overlay that
// searches across four kinds of destination in one list: open threads (across
// every project, not just the active one), projects, right-panel modes, and
// app commands. A native <dialog> (showModal) so it inherits the top-layer
// focus trap, inert background, and Esc-to-close for free — mirrors the
// file-search palette (Cmd/Ctrl+P) it sits beside.
//
// The sibling to this is the per-project thread filter in the projects sidebar
// (projects-pane.ts): that narrows one project's thread list in place, this
// jumps anywhere in the app.

// A right-panel destination, kept to the always-available modes so the palette
// never offers a panel that a disabled plugin would make a no-op.
const PANEL_ITEMS: readonly { mode: RightPanelMode; label: string }[] = [
  { mode: 'explorer', label: 'Panel (Explorer)' },
  { mode: 'terminal', label: 'Terminal' },
  { mode: 'changes', label: 'Changes' },
  { mode: 'prs', label: 'Pull Requests' },
  { mode: 'browser', label: 'Browser' },
]

// Per-project thread hit flattened for the palette. `updatedAt` drives ordering;
// a synchronous seed from the store (which lacks a timestamp) uses 0 and is
// replaced once the catalog fetch lands.
interface ThreadHit {
  threadId: string
  projectId: string
  projectName: string
  title: string
  updatedAt: number
}

type PaletteEntry =
  | { kind: 'thread'; hit: ThreadHit }
  | { kind: 'project'; id: string; name: string }
  | { kind: 'panel'; mode: RightPanelMode; label: string }
  | { kind: 'command'; label: string; run: () => void }

// Section headers, and how many rows each section shows. Threads and projects
// are capped so a large workspace can't bury the commands; the query narrows
// them well before the cap bites.
const THREAD_LIMIT = 25
const PROJECT_LIMIT = 25

/** Case-insensitive AND-of-terms match, mirroring the file-search palette. */
function matches(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = haystack.toLowerCase()
  return terms.every((term) => hay.includes(term))
}

let dialogEl: HTMLDialogElement | null = null
let openImpl: (() => void) | null = null

export function openCommandPalette(): void {
  openImpl?.()
}

export function closeCommandPalette(): void {
  if (dialogEl?.open) dialogEl.close()
}

export function isCommandPaletteOpen(): boolean {
  return !!dialogEl?.open
}

export function mountCommandPalette(store: AppStore, api: ApiClient): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'command-palette-dialog'
  dialog.className = 'command-palette-overlay'

  const input = el('input', {
    type: 'text',
    class: 'command-palette-input',
    placeholder: 'Search threads, projects, panels, commands…',
    'aria-label': 'Command palette',
    spellcheck: 'false',
    autocomplete: 'off',
  })

  const list = el('div', { class: 'command-palette-results', role: 'listbox' })
  const empty = el('div', { class: 'command-palette-empty' }, 'No matches')
  empty.hidden = true

  const shell = el('div', { class: 'command-palette-shell' }, input, list, empty)
  dialog.append(shell)
  document.body.append(dialog)
  dialogEl = dialog

  let entries: PaletteEntry[] = []
  let selectedIdx = 0
  // Threads are fetched across all projects on each open; a token guards against
  // a slower earlier open's fetch landing after a newer one (mirrors the
  // file-search palette's roadmap-fetch race handling).
  let threadHits: ThreadHit[] = []
  let threadToken = 0

  function commandItems(): PaletteEntry[] {
    const hasWorkspace = !!store.getState().workspaceRoot
    const commands: PaletteEntry[] = []
    commands.push({
      kind: 'command',
      label: 'New project',
      run: () => {
        void createNewProject(store, api)
      },
    })
    if (hasWorkspace) {
      commands.push({ kind: 'command', label: 'New thread', run: () => openNewThread(store) })
      commands.push({
        kind: 'command',
        label: 'Quick open files',
        run: () => {
          openFileSearchDialog()
        },
      })
      commands.push({
        kind: 'command',
        label: 'Find in conversation',
        run: () => {
          openConversationSearch()
        },
      })
    }
    commands.push({
      kind: 'command',
      label: 'Settings',
      run: () => {
        openSettingsDialog()
      },
    })
    commands.push({
      kind: 'command',
      label: 'Keyboard shortcuts',
      run: () => {
        openKeyboardShortcutsDialog()
      },
    })
    return commands
  }

  function computeEntries(query: string): PaletteEntry[] {
    const { projects } = store.getState()

    const threads: PaletteEntry[] = threadHits
      .filter((hit) => matches(`${hit.title} ${hit.projectName}`, query))
      .slice(0, THREAD_LIMIT)
      .map((hit) => ({ kind: 'thread', hit }))

    const projectEntries: PaletteEntry[] = projects
      .map((p) => ({ id: p.id, name: projectDisplayName(p) }))
      .filter((p) => matches(p.name, query))
      .slice(0, PROJECT_LIMIT)
      .map((p) => ({ kind: 'project', id: p.id, name: p.name }))

    const panels: PaletteEntry[] = PANEL_ITEMS.filter((p) => matches(p.label, query)).map((p) => ({
      kind: 'panel',
      mode: p.mode,
      label: p.label,
    }))

    const commands = commandItems().filter((c) => c.kind === 'command' && matches(c.label, query))

    return [...threads, ...projectEntries, ...panels, ...commands]
  }

  function sectionTitle(entry: PaletteEntry): string {
    switch (entry.kind) {
      case 'thread':
        return 'Threads'
      case 'project':
        return 'Projects'
      case 'panel':
        return 'Panels'
      case 'command':
        return 'Commands'
    }
  }

  function rowFor(entry: PaletteEntry, selected: boolean): HTMLElement {
    const icon = el('span', { class: 'command-palette-icon' }, searchIcon('ui-icon ui-icon-sm'))
    const cls = `command-palette-item command-palette-item-${entry.kind}${selected ? ' selected' : ''}`
    if (entry.kind === 'thread') {
      return el(
        'div',
        { class: cls, role: 'option', title: `${entry.hit.title} — ${entry.hit.projectName}` },
        icon,
        el('span', { class: 'command-palette-name' }, entry.hit.title || 'New Thread'),
        el('span', { class: 'command-palette-context' }, entry.hit.projectName),
      )
    }
    const label =
      entry.kind === 'project' ? entry.name : entry.kind === 'panel' ? entry.label : entry.label
    return el(
      'div',
      { class: cls, role: 'option', title: label },
      icon,
      el('span', { class: 'command-palette-name' }, label),
    )
  }

  function renderResults(): void {
    clear(list)
    empty.hidden = entries.length > 0
    let lastSection: string | null = null
    entries.forEach((entry, i) => {
      const section = sectionTitle(entry)
      if (section !== lastSection) {
        lastSection = section
        list.append(el('div', { class: 'command-palette-section' }, section))
      }
      const row = rowFor(entry, i === selectedIdx)
      // mousedown (not click) so we act before the dialog steals focus/closes.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        choose(i)
      })
      list.append(row)
    })
  }

  function updateSelection(): void {
    const items = list.querySelectorAll('.command-palette-item')
    items.forEach((node, i) => node.classList.toggle('selected', i === selectedIdx))
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' })
  }

  function runQuery(query: string): void {
    entries = computeEntries(query.trim())
    selectedIdx = 0
    renderResults()
  }

  function choose(idx: number): void {
    const entry = entries[idx]
    if (!entry) return
    closeCommandPalette()
    switch (entry.kind) {
      case 'thread':
        switchProjectThread(store, api, entry.hit.projectId, entry.hit.threadId)
        return
      case 'project':
        switchProject(store, api, entry.id)
        return
      case 'panel':
        openRightPanelWithWorkspace(store, api, entry.mode)
        return
      case 'command':
        entry.run()
        return
    }
  }

  // The active project's threads straight from the store — instantly available
  // and authoritative for that project (it may hold a brand-new thread the
  // on-disk catalog hasn't recorded yet). `updatedAt` is 0 because the store
  // Thread carries no timestamp; the catalog supplies real ones for ordering.
  function storeThreadHits(): ThreadHit[] {
    const { projects, threads, activeProjectId } = store.getState()
    const active = projects.find((p) => p.id === activeProjectId)
    if (!active) return []
    return threads.map((t) => ({
      threadId: t.id,
      projectId: active.id,
      projectName: projectDisplayName(active),
      title: t.title,
      updatedAt: 0,
    }))
  }

  const threadKey = (h: ThreadHit): string => `${h.projectId} ${h.threadId}`

  async function loadThreads(): Promise<void> {
    const token = ++threadToken
    const { projects } = store.getState()
    const perProject = await Promise.all(
      projects.map((p) =>
        api.threads
          .catalog(p.id)
          .then((hits) => ({ project: p, hits }))
          .catch(() => ({ project: p, hits: [] })),
      ),
    )
    if (token !== threadToken) return // superseded by a newer open
    const catalogHits = perProject
      .flatMap(({ project, hits }) =>
        hits.map((hit): ThreadHit => ({
          threadId: hit.id,
          projectId: project.id,
          projectName: projectDisplayName(project),
          title: hit.title,
          updatedAt: hit.updatedAt,
        })),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
    // Merge rather than replace: keep the catalog's timestamp-sorted set, then
    // append any live active-project thread the catalog hasn't recorded yet, so
    // known threads never vanish while the catalog is empty or still rebuilding.
    const seen = new Set(catalogHits.map(threadKey))
    const extras = storeThreadHits().filter((h) => !seen.has(threadKey(h)))
    threadHits = [...catalogHits, ...extras]
    if (dialog.open) runQuery(input.value)
  }

  input.addEventListener('input', () => {
    runQuery(input.value)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = Math.min(selectedIdx + 1, entries.length - 1)
      updateSelection()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = Math.max(selectedIdx - 1, 0)
      updateSelection()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(selectedIdx)
    }
    // Escape is handled by the native <dialog> cancel → close.
  })

  // Clicking the backdrop (the dialog element itself, outside the shell) closes.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) closeCommandPalette()
  })

  openImpl = (): void => {
    if (dialog.open) return
    input.value = ''
    selectedIdx = 0
    // Seed threads synchronously from what the store already holds so the
    // palette is useful on the first frame; the cross-project catalog fetch
    // then folds in every other project's threads (timestamp-sorted).
    threadHits = storeThreadHits()
    dialog.showModal()
    input.focus()
    runQuery('')
    void loadThreads()
  }
}
