import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el, clear } from '../dom/helpers.ts'
import { materialFileIconUrl, mountMaterialIcon } from '../icons/material-file-icons.ts'
import { openWorkspaceFile } from '../controller/files.ts'

// Cmd/Ctrl+P "quick open" palette. A native <dialog> (showModal) so we inherit
// the top-layer focus trap, inert background, and Esc-to-close for free — mirrors
// the settings dialog. Matches are pulled from the workspace file index
// (api.index.query) as the user types; choosing one opens it in the explorer.

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
  }) as HTMLInputElement

  const list = el('div', { class: 'file-search-results', role: 'listbox' })
  const empty = el('div', { class: 'file-search-empty' }, 'No matching files')
  empty.hidden = true

  const shell = el('div', { class: 'file-search-shell' }, input, list, empty)
  dialog.append(shell)
  document.body.append(dialog)
  dialogEl = dialog

  let results: string[] = []
  let selectedIdx = 0
  // Each query bumps this token; a stale resolution (a slower earlier query
  // landing after a newer one) is discarded by comparing against the latest.
  let queryToken = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  function renderResults(): void {
    clear(list)
    empty.hidden = results.length > 0
    results.forEach((path, i) => {
      const slash = path.lastIndexOf('/')
      const name = slash === -1 ? path : path.slice(slash + 1)
      const dir = slash === -1 ? '' : path.slice(0, slash)
      const icon = el('span', { class: 'file-search-icon' })
      mountMaterialIcon(icon, materialFileIconUrl(path), name)
      const item = el(
        'div',
        {
          class: `file-search-item${i === selectedIdx ? ' selected' : ''}`,
          role: 'option',
          title: path,
        },
        icon,
        el('span', { class: 'file-search-name' }, name),
        el('span', { class: 'file-search-dir' }, dir),
      )
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
    let matches: string[]
    try {
      matches = await api.index.query(query.trim())
    } catch {
      matches = []
    }
    if (token !== queryToken) return // superseded by a newer query
    results = matches
    selectedIdx = 0
    renderResults()
  }

  async function choose(idx: number): Promise<void> {
    const path = results[idx]
    if (!path) return
    closeFileSearchDialog()
    try {
      // Reveals the explorer pane and scrolls the tree to the file (see
      // openWorkspaceFile → store events the file-tree listens for).
      await openWorkspaceFile(store, api, path)
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

  openImpl = () => {
    if (dialog.open) return
    input.value = ''
    results = []
    selectedIdx = 0
    clear(list)
    empty.hidden = true
    dialog.showModal()
    input.focus()
    // Seed with the first slice of the index so the palette is useful on open.
    void runQuery('')
  }
}
