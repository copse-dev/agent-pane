import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el, clear } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { materialFileIconUrl, mountMaterialIcon } from '../icons/material-file-icons.ts'
import { openWorkspaceFile } from '../controller/files.ts'
import { navigateToRoadmapItem } from '../controller/panels.ts'
import { ROADMAP_PLANS_PLUGIN_ID } from '@copse/agent/plugins/roadmap-plans-plugin.ts'

// Cmd/Ctrl+P "quick open" palette. A native <dialog> (showModal) so we inherit
// the top-layer focus trap, inert background, and Esc-to-close for free — mirrors
// the settings dialog. Matches are pulled from the workspace file index
// (api.index.query) as the user types; choosing one opens it in the explorer.
//
// Beyond files, the palette is a light "search everywhere": while a query is
// typed it also surfaces matching roadmap items in a labelled section beneath
// the file matches — the JetBrains Search Everywhere / VS Code quick-open
// pattern of mixing result types in one list with section headers. Choosing a
// roadmap match opens the Roadmap pane with that item selected.

// Derive the item shape from the IPC surface so this view never imports
// main-process types directly (mirrors roadmap-pane.ts).
type RoadmapItem = Awaited<ReturnType<ApiClient['roadmap']['list']>>[number]

type SearchEntry = { kind: 'file'; path: string } | { kind: 'roadmap'; item: RoadmapItem }

// Keep the roadmap section short — it supplements the file results, and the
// backlog is small enough that a query narrowing to 8 is always achievable.
const ROADMAP_RESULT_LIMIT = 8

// Same glyph as the titlebar's Roadmap panel button (panel-mode-controls.ts).
const ROADMAP_ICON_PATHS = ['M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4Z', 'M8 2v16', 'M16 6v16']

/**
 * Roadmap items matching `query`: every whitespace-separated term must appear
 * in the title, prompt body, or extra fields (case-insensitive) — mirroring the
 * knowledge store's own `searchKnowledgeNotes` semantics. An empty query
 * matches nothing: the palette's empty state stays a file quick-open seed.
 */
function matchRoadmapItems(items: RoadmapItem[], query: string): RoadmapItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return items
    .filter((item) => {
      const haystack =
        `${item.title}\n${item.body}\n${Object.values(item.fields).join(' ')}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .slice(0, ROADMAP_RESULT_LIMIT)
}

let dialogEl: HTMLDialogElement | null = null
let openImpl: (() => void) | null = null

export function openFileSearchDialog(): void {
  openImpl?.()
}

export function closeFileSearchDialog(): void {
  if (dialogEl?.open) dialogEl.close()
}

export function isFileSearchDialogOpen(): boolean {
  return !!dialogEl?.open
}

export function mountFileSearchDialog(store: AppStore, api: ApiClient): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'file-search-dialog'
  dialog.className = 'file-search-overlay'

  const input = el('input', {
    type: 'text',
    class: 'file-search-input',
    placeholder: 'Search files by name…',
    'aria-label': 'Search files',
    spellcheck: 'false',
    autocomplete: 'off',
  })

  const list = el('div', { class: 'file-search-results', role: 'listbox' })
  const empty = el('div', { class: 'file-search-empty' }, 'No matches')
  empty.hidden = true

  const shell = el('div', { class: 'file-search-shell' }, input, list, empty)
  dialog.append(shell)
  document.body.append(dialog)
  dialogEl = dialog

  let results: SearchEntry[] = []
  let selectedIdx = 0
  // Roadmap items are fetched once per palette open (the backlog is small);
  // an empty list doubles as "feature disabled" and "no items". Cleared on
  // every open and guarded by a token so a previous open's snapshot (possibly
  // from another workspace) never renders, and a slower older fetch cannot
  // overwrite a newer one.
  let roadmapItems: RoadmapItem[] = []
  let roadmapToken = 0
  // Each query bumps this token; a stale resolution (a slower earlier query
  // landing after a newer one) is discarded by comparing against the latest.
  let queryToken = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  function fileRow(path: string, selected: boolean): HTMLElement {
    const slash = path.lastIndexOf('/')
    const name = slash === -1 ? path : path.slice(slash + 1)
    const dir = slash === -1 ? '' : path.slice(0, slash)
    const icon = el('span', { class: 'file-search-icon' })
    mountMaterialIcon(icon, materialFileIconUrl(path), name)
    return el(
      'div',
      {
        class: `file-search-item${selected ? ' selected' : ''}`,
        role: 'option',
        title: path,
      },
      icon,
      el('span', { class: 'file-search-name' }, name),
      el('span', { class: 'file-search-dir' }, dir),
    )
  }

  function roadmapRow(item: RoadmapItem, selected: boolean): HTMLElement {
    const icon = el('span', { class: 'file-search-icon file-search-roadmap-icon' })
    icon.append(outlineIcon('roadmap', ROADMAP_ICON_PATHS, 'file-search-roadmap-svg'))
    const status = item.status ?? 'ready'
    const row = el(
      'div',
      {
        class: `file-search-item file-search-roadmap-item${selected ? ' selected' : ''}`,
        role: 'option',
        title: item.body,
      },
      icon,
      el('span', { class: 'file-search-name' }, item.title || '(untitled)'),
    )
    // Match the Roadmap list: default `ready` (and `done`) stay silent; only
    // exceptional statuses get a chip.
    if (status === 'blocked' || status === 'conflicts' || status === 'archived') {
      row.append(el('span', { class: `roadmap-status-badge is-${status}` }, status))
    }
    return row
  }

  function renderResults(): void {
    clear(list)
    empty.hidden = results.length > 0
    let roadmapHeaderAdded = false
    results.forEach((entry, i) => {
      // File matches lead unlabelled (the palette's primary role); the roadmap
      // block is set off by a section header, Search Everywhere style.
      if (entry.kind === 'roadmap' && !roadmapHeaderAdded) {
        roadmapHeaderAdded = true
        list.append(el('div', { class: 'file-search-section' }, 'Roadmap'))
      }
      const item =
        entry.kind === 'file'
          ? fileRow(entry.path, i === selectedIdx)
          : roadmapRow(entry.item, i === selectedIdx)
      // mousedown (not click) so we act before the dialog steals focus/closes.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        void choose(i)
      })
      list.append(item)
    })
  }

  function updateSelection(): void {
    const items = list.querySelectorAll('.file-search-item')
    items.forEach((node, i) => node.classList.toggle('selected', i === selectedIdx))
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' })
  }

  async function runQuery(query: string): Promise<void> {
    const token = ++queryToken
    const trimmed = query.trim()
    let files: string[]
    try {
      files = await api.index.query(trimmed)
    } catch {
      files = []
    }
    if (token !== queryToken) return // superseded by a newer query
    results = [
      ...files.map((path): SearchEntry => ({ kind: 'file', path })),
      ...matchRoadmapItems(roadmapItems, trimmed).map((item): SearchEntry => ({
        kind: 'roadmap',
        item,
      })),
    ]
    selectedIdx = 0
    renderResults()
  }

  async function loadRoadmapItems(): Promise<void> {
    const token = ++roadmapToken
    let items: RoadmapItem[]
    try {
      // Roadmap is gated by the `copse.roadmap-plans` first-party plugin; only
      // surface roadmap matches while that plugin is enabled (mirrors the Roadmap
      // pane's titlebar-button gate).
      const plugins = await api.plugins.list()
      const enabled = plugins.plugins.some((p) => p.id === ROADMAP_PLANS_PLUGIN_ID && p.enabled)
      items = enabled ? await api.roadmap.list() : []
    } catch {
      items = []
    }
    if (token !== roadmapToken) return // superseded by a newer open's fetch
    roadmapItems = items
  }

  async function choose(idx: number): Promise<void> {
    const entry = results[idx]
    if (!entry) return
    closeFileSearchDialog()
    if (entry.kind === 'roadmap') {
      navigateToRoadmapItem(store, entry.item.id)
      return
    }
    try {
      // Reveals the explorer pane and scrolls the tree to the file (see
      // openWorkspaceFile → store events the file-tree listens for).
      await openWorkspaceFile(store, api, entry.path)
    } catch {
      // ignore read errors (binary files, permissions, etc.)
    }
  }

  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce)
    const value = input.value
    debounce = setTimeout(() => void runQuery(value), 100)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = Math.min(selectedIdx + 1, results.length - 1)
      updateSelection()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = Math.max(selectedIdx - 1, 0)
      updateSelection()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void choose(selectedIdx)
    }
    // Escape is handled by the native <dialog> cancel → close.
  })

  // Clicking the backdrop (the dialog element itself, outside the shell) closes.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) closeFileSearchDialog()
  })

  openImpl = (): void => {
    if (dialog.open) return
    input.value = ''
    results = []
    selectedIdx = 0
    clear(list)
    empty.hidden = true
    dialog.showModal()
    input.focus()
    // Refresh the roadmap snapshot for this open (dropping the previous
    // open's, which may be another workspace's); if the user out-typed the
    // fetch, re-run their query so roadmap matches appear once loaded.
    roadmapItems = []
    void loadRoadmapItems().then(() => {
      if (dialog.open && input.value.trim()) void runQuery(input.value)
    })
    // Seed with the first slice of the index so the palette is useful on open.
    void runQuery('')
  }
}
