import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadCatalogHit } from '@shared/types'
import type { ComposerTextInput } from './composer-editor.ts'
import { clear } from '../dom/helpers.ts'
import { attachmentIcon } from '../dom/attachment-icons.ts'
import {
  listShellsForThread,
  readShellScrollback,
  type ShellCatalogEntry,
} from '../terminal/shell-catalog.ts'
import {
  READ_TERMINAL_ENABLED_DEFAULT,
  READ_TERMINAL_ENABLED_SETTING,
} from '@shared/terminal/read-terminal.ts'

// A past conversation thread reference. Rendered as a `currentColor` outline
// icon (matching the titlebar/attach chrome) instead of a 🧵 emoji so it stays
// theme-aware and platform-consistent — see `attachment-icons.ts`.
/** The thread-reference icon at a caller-styled size/color. */
export function threadIcon(className: string): SVGSVGElement {
  return attachmentIcon('thread', className)
}

export function shellIcon(className: string): SVGSVGElement {
  return attachmentIcon('shell', className)
}

export interface AttachedThreadRef {
  threadId: string
  title: string
  updatedAt: number
  spinePath: string
}

/** Snapshot of a Shells tab attached via `@shell`. */
export interface AttachedShellRef {
  tabId: string
  label: string
  content: string
}

export interface MentionPickerOptions {
  input: ComposerTextInput
  inputBar: HTMLElement
  store: AppStore
  api: ApiClient
  onAttach: (file: { path: string; content: string }) => void
  onAttachThread: (thread: AttachedThreadRef) => void
  onAttachShell: (shell: AttachedShellRef) => void
}

type MentionItem =
  | { kind: 'thread'; hit: ThreadCatalogHit }
  | { kind: 'shell'; entry: ShellCatalogEntry }
  | { kind: 'file'; path: string }

/** Past conversations shown above files; the rest of the list is workspace files. */
const MAX_THREADS = 5

export function relativeDate(ts: number): string {
  const day = 86_400_000
  const diff = Date.now() - ts
  if (diff < day) return 'today'
  if (diff < 2 * day) return 'yesterday'
  if (diff < 7 * day) return `${String(Math.floor(diff / day))}d ago`
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function matchesQuery(label: string, query: string): boolean {
  if (!query) return true
  return label.toLowerCase().includes(query.toLowerCase())
}

export function initMentionPicker(opts: MentionPickerOptions): () => void {
  const { input, inputBar, store, api, onAttach, onAttachThread, onAttachShell } = opts

  const picker = document.createElement('div')
  picker.className = 'mention-picker'
  picker.setAttribute('role', 'listbox')
  picker.hidden = true
  inputBar.append(picker)

  let mentionStart = -1
  let selectedIdx = 0
  let currentItems: MentionItem[] = []

  async function updatePicker(query: string): Promise<void> {
    const { activeProjectId, activeThreadId } = store.getState()

    const readTerminalEnabled =
      (await api.settings.get(READ_TERMINAL_ENABLED_SETTING).catch(() => null)) ??
      READ_TERMINAL_ENABLED_DEFAULT

    // Two sources, queried in parallel on each keystroke: past threads (current
    // project only, #644) rendered above workspace files. Open shells sit above
    // files when the kill switch allows them.
    const [threads, files] = await Promise.all([
      activeProjectId
        ? api.threads.catalog(activeProjectId, query).catch(() => [])
        : Promise.resolve([]),
      api.index.query(query).catch(() => []),
    ])

    const shellItems: MentionItem[] =
      readTerminalEnabled === true
        ? listShellsForThread(activeThreadId)
            .filter((s) => matchesQuery(s.label, query) || matchesQuery('shell', query))
            .map((entry) => ({ kind: 'shell', entry }))
        : []

    const threadItems: MentionItem[] = threads
      .filter((t) => t.id !== activeThreadId)
      .slice(0, MAX_THREADS)
      .map((hit) => ({ kind: 'thread', hit }))
    const fileItems: MentionItem[] = files.map((path) => ({ kind: 'file', path }))
    currentItems = [...shellItems, ...threadItems, ...fileItems]

    clear(picker)
    selectedIdx = 0
    currentItems.forEach((item, i) => {
      const el = document.createElement('div')
      el.className = `mention-item${
        item.kind === 'thread'
          ? ' mention-item-thread'
          : item.kind === 'shell'
            ? ' mention-item-shell'
            : ''
      }${i === 0 ? ' selected' : ''}`
      el.setAttribute('role', 'option')
      if (item.kind === 'thread') {
        const icon = threadIcon('mention-thread-icon')
        const title = document.createElement('span')
        title.className = 'mention-thread-title'
        title.textContent = item.hit.title || 'Untitled thread'
        const date = document.createElement('span')
        date.className = 'mention-thread-date'
        date.textContent = relativeDate(item.hit.updatedAt)
        el.append(icon, title, date)
      } else if (item.kind === 'shell') {
        const icon = shellIcon('mention-shell-icon')
        const title = document.createElement('span')
        title.className = 'mention-shell-title'
        title.textContent = item.entry.label
        const kind = document.createElement('span')
        kind.className = 'mention-shell-kind'
        kind.textContent = item.entry.active ? 'active shell' : 'shell'
        el.append(icon, title, kind)
      } else {
        el.textContent = item.path
      }
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        void selectItem(i)
      })
      picker.append(el)
    })
    picker.hidden = currentItems.length === 0
  }

  function removeMentionText(): void {
    const val = input.value
    input.value = val.slice(0, mentionStart) + val.slice(input.selectionStart)
  }

  async function selectItem(idx: number): Promise<void> {
    const item = currentItems[idx]
    if (!item) {
      hidePicker()
      return
    }
    if (item.kind === 'thread') {
      onAttachThread({
        threadId: item.hit.id,
        title: item.hit.title,
        updatedAt: item.hit.updatedAt,
        spinePath: item.hit.spinePath,
      })
      removeMentionText()
      hidePicker()
      return
    }
    if (item.kind === 'shell') {
      const content = readShellScrollback(item.entry.tabId) ?? ''
      onAttachShell({
        tabId: item.entry.tabId,
        label: item.entry.label,
        content: content.trim() ? content : '(no output yet)',
      })
      removeMentionText()
      hidePicker()
      return
    }
    try {
      const content = await api.fs.readFile(item.path)
      onAttach({ path: item.path, content })
    } catch {
      /* ignore read errors */
    }
    removeMentionText()
    hidePicker()
  }

  function hidePicker(): void {
    picker.hidden = true
    mentionStart = -1
  }

  function updateSelection(): void {
    picker
      .querySelectorAll('.mention-item')
      .forEach((el, i) => el.classList.toggle('selected', i === selectedIdx))
  }

  input.el.addEventListener('input', () => {
    const val = input.value
    const cursor = input.selectionStart
    const atIdx = val.lastIndexOf('@', cursor - 1)
    if (atIdx === -1 || val.slice(atIdx + 1, cursor).includes(' ')) {
      hidePicker()
      return
    }
    mentionStart = atIdx
    void updatePicker(val.slice(atIdx + 1, cursor))
  })

  input.el.addEventListener('keydown', (e) => {
    if (picker.hidden) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1)
      updateSelection()
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = Math.max(selectedIdx - 1, 0)
      updateSelection()
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      void selectItem(selectedIdx)
    }
    if (e.key === 'Escape') {
      hidePicker()
    }
  })

  document.addEventListener('mousedown', (e) => {
    if (!picker.contains(e.target as Node)) hidePicker()
  })

  return hidePicker
}
