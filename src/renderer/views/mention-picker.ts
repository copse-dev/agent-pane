import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadCatalogHit } from '@shared/types'
import type { ComposerTextInput } from './composer-editor.ts'
import { clear } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'

// lucide `messages-square` — a past conversation thread. Rendered as a
// `currentColor` outline icon (matching the titlebar/attach chrome) instead of a
// 🧵 emoji so it stays theme-aware and platform-consistent.
const THREAD_ICON_PATHS = [
  'M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2Z',
  'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
]

/** The thread-reference icon at a caller-styled size/color. */
export function threadIcon(className: string): SVGSVGElement {
  return outlineIcon('thread', THREAD_ICON_PATHS, className)
}

export interface AttachedThreadRef {
  threadId: string
  title: string
  updatedAt: number
  spinePath: string
}

export interface MentionPickerOptions {
  input: ComposerTextInput
  inputBar: HTMLElement
  store: AppStore
  api: ApiClient
  onAttach: (file: { path: string; content: string }) => void
  onAttachThread: (thread: AttachedThreadRef) => void
}

type MentionItem = { kind: 'thread'; hit: ThreadCatalogHit } | { kind: 'file'; path: string }

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

export function initMentionPicker(opts: MentionPickerOptions): () => void {
  const { input, inputBar, store, api, onAttach, onAttachThread } = opts

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

    // Two sources, queried in parallel on each keystroke: past threads (current
    // project only, #644) rendered above workspace files.
    const [threads, files] = await Promise.all([
      activeProjectId
        ? api.threads.catalog(activeProjectId, query).catch(() => [])
        : Promise.resolve([]),
      api.index.query(query).catch(() => []),
    ])

    const threadItems: MentionItem[] = threads
      .filter((t) => t.id !== activeThreadId)
      .slice(0, MAX_THREADS)
      .map((hit) => ({ kind: 'thread', hit }))
    const fileItems: MentionItem[] = files.map((path) => ({ kind: 'file', path }))
    currentItems = [...threadItems, ...fileItems]

    clear(picker)
    selectedIdx = 0
    currentItems.forEach((item, i) => {
      const el = document.createElement('div')
      el.className = `mention-item${item.kind === 'thread' ? ' mention-item-thread' : ''}${
        i === 0 ? ' selected' : ''
      }`
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
