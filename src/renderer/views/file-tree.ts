import { el, clear } from '../dom/helpers.ts'
import {
  materialFileIconUrl,
  materialFolderIconUrl,
  mountMaterialIcon,
} from '../icons/material-file-icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { WORKSPACE_PATH_MIME } from '../attachments/handle-file-drop.ts'
import { openWorkspaceFile } from '../controller/files.ts'

function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child
}

export function mountFileTree(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const refreshBtn = el('button', { class: 'sidebar-refresh', 'aria-label': 'Refresh' }, '⟳')
  const header = el('div', { class: 'sidebar-header sidebar-header-compact' }, refreshBtn)
  const treeEl = el('div', { class: 'file-tree', role: 'tree' })
  root.append(header, treeEl)

  let selectedRow: HTMLElement | null = null
  let rootLoad: Promise<void> | null = null
  const rowByPath = new Map<string, HTMLElement>()
  const dirByPath = new Map<
    string,
    {
      expand: () => Promise<void>
    }
  >()

  function selectRow(row: HTMLElement): void {
    if (selectedRow === row) return
    selectedRow?.classList.remove('selected')
    row.classList.add('selected')
    selectedRow = row
  }

  async function openFile(path: string) {
    try {
      await openWorkspaceFile(store, api, path)
    } catch {
      // ignore read errors (binary files, permissions, etc.)
    }
  }

  async function revealPath(path: string, isDirectory = false): Promise<void> {
    await rootLoad
    const segments = path.split('/').filter(Boolean)
    let dir = ''
    const expandThrough = isDirectory ? segments.length : segments.length - 1
    for (let i = 0; i < expandThrough; i++) {
      dir = join(dir, segments[i]!)
      const controller = dirByPath.get(dir)
      if (!controller) return
      await controller.expand()
    }
    const row = rowByPath.get(path)
    if (!row) return
    selectRow(row)
    row.scrollIntoView({ block: 'nearest' })
  }

  function renderRow(
    entry: { name: string; isDir: boolean },
    path: string,
    depth: number,
  ): HTMLElement {
    const twisty = el('span', { class: 'tree-twisty' }, entry.isDir ? '▶' : '')
    const icon = el('span', { class: 'tree-icon' })
    if (entry.isDir) {
      mountMaterialIcon(icon, materialFolderIconUrl(path, false), `${entry.name} folder`)
    } else {
      mountMaterialIcon(icon, materialFileIconUrl(path), entry.name)
    }
    const row = el(
      'button',
      { class: 'tree-row', role: 'treeitem', title: path },
      twisty,
      icon,
      el('span', {}, entry.name),
    )
    row.style.paddingLeft = `${8 + depth * 14}px`
    rowByPath.set(path, row)

    const container = el('div', {})
    container.append(row)

    if (entry.isDir) {
      const childrenEl = el('div', { class: 'tree-children' })
      childrenEl.hidden = true
      container.append(childrenEl)
      let loaded = false
      let expanded = false
      const expand = async () => {
        if (expanded) return
        expanded = !expanded
        twisty.textContent = expanded ? '▼' : '▶'
        mountMaterialIcon(icon, materialFolderIconUrl(path, expanded), `${entry.name} folder`)
        childrenEl.hidden = !expanded
        if (expanded && !loaded) {
          loaded = true
          await loadInto(childrenEl, path, depth + 1)
        }
      }
      dirByPath.set(path, { expand })
      row.addEventListener('click', () => {
        if (expanded) {
          expanded = false
          twisty.textContent = '▶'
          mountMaterialIcon(icon, materialFolderIconUrl(path, false), `${entry.name} folder`)
          childrenEl.hidden = true
          return
        }
        void expand()
      })
    } else {
      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(WORKSPACE_PATH_MIME, path)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      })
      row.addEventListener('click', () => {
        selectRow(row)
        void openFile(path)
      })
    }
    return container
  }

  async function loadInto(target: HTMLElement, dirPath: string, depth: number) {
    try {
      const entries = await api.fs.listDir(dirPath)
      clear(target)
      if (entries.length === 0) {
        target.append(el('div', { class: 'sidebar-empty' }, '(empty)'))
        return
      }
      for (const entry of entries) {
        target.append(renderRow(entry, join(dirPath, entry.name), depth))
      }
    } catch (err) {
      clear(target)
      const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Could not read folder'
      target.append(el('div', { class: 'sidebar-empty' }, message))
    }
  }

  function refresh() {
    if (!store.getState().workspaceRoot) {
      clear(treeEl)
      treeEl.append(el('div', { class: 'sidebar-empty' }, 'No folder open'))
      return
    }
    selectedRow = null
    rowByPath.clear()
    dirByPath.clear()
    rootLoad = loadInto(treeEl, '', 0)
    void rootLoad.then(() => {
      const openPath = store.getState().openFile?.path
      if (openPath) void revealPath(openPath)
    })
  }

  refreshBtn.addEventListener('click', refresh)
  const unsubs = [
    store.on('workspace_changed', refresh),
    store.on('panel_changed', () => {
      const path = store.getState().openFile?.path
      if (path) void revealPath(path)
    }),
    store.on('explorer_reveal', (path) => {
      void revealPath(path, true)
    }),
  ]

  refresh()
  return () => unsubs.forEach((unsub) => unsub())
}
