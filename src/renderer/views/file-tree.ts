import { el, clear } from '../dom/helpers.ts'
import {
  materialFileIconUrl,
  materialFolderIconUrl,
  mountMaterialIcon,
} from '../icons/material-file-icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// Minimal renderer-side language detection for Monaco. Mirrors the main-process
// language service for the common cases; unknown extensions fall back to
// plaintext and Monaco still renders the text fine.
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  md: 'markdown',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  toml: 'ini',
  xml: 'xml',
  sql: 'sql',
  graphql: 'graphql',
}

function detectLanguage(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  return LANG[lower.split('.').pop() ?? ''] ?? 'plaintext'
}

function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child
}

export function mountFileTree(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const title = el('span', {}, 'Explorer')
  const refreshBtn = el('button', { class: 'sidebar-refresh', 'aria-label': 'Refresh' }, '⟳')
  const header = el('div', { class: 'sidebar-header' }, title, refreshBtn)
  const treeEl = el('div', { class: 'file-tree', role: 'tree' })
  root.append(header, treeEl)

  let selectedRow: HTMLElement | null = null

  async function openFile(path: string, name: string) {
    try {
      const content = await api.fs.readFile(path)
      store.setState({
        openFile: { path, content, language: detectLanguage(name) },
        panelTab: 'file',
        filesPaneOpen: true,
      })
      store.emit('panel_changed')
      store.emit('files_pane_changed')
    } catch {
      // ignore read errors (binary files, permissions, etc.)
    }
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

    const container = el('div', {})
    container.append(row)

    if (entry.isDir) {
      const childrenEl = el('div', { class: 'tree-children' })
      childrenEl.hidden = true
      container.append(childrenEl)
      let loaded = false
      let expanded = false
      row.addEventListener('click', () => {
        expanded = !expanded
        twisty.textContent = expanded ? '▼' : '▶'
        mountMaterialIcon(
          icon,
          materialFolderIconUrl(path, expanded),
          `${entry.name} folder`,
        )
        childrenEl.hidden = !expanded
        if (expanded && !loaded) {
          loaded = true
          void loadInto(childrenEl, path, depth + 1)
        }
      })
    } else {
      row.addEventListener('click', () => {
        if (selectedRow) selectedRow.classList.remove('selected')
        row.classList.add('selected')
        selectedRow = row
        void openFile(path, entry.name)
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
    } catch {
      clear(target)
      target.append(el('div', { class: 'sidebar-empty' }, 'Could not read folder'))
    }
  }

  function refresh() {
    if (!store.getState().workspaceRoot) {
      clear(treeEl)
      treeEl.append(el('div', { class: 'sidebar-empty' }, 'No folder open'))
      return
    }
    selectedRow = null
    void loadInto(treeEl, '', 0)
  }

  refreshBtn.addEventListener('click', refresh)
  const unsub = store.on('workspace_changed', refresh)

  refresh()
  return unsub
}
