import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

export interface MentionPickerOptions {
  textarea: HTMLTextAreaElement
  inputBar: HTMLElement
  store: AppStore
  api: ApiClient
  onAttach: (file: { path: string; content: string }) => void
}

export function initMentionPicker(opts: MentionPickerOptions): () => void {
  const { textarea, inputBar, api, onAttach } = opts

  const picker = document.createElement('div')
  picker.className = 'mention-picker'
  picker.setAttribute('role', 'listbox')
  picker.hidden = true
  inputBar.append(picker)

  let mentionStart = -1
  let selectedIdx = 0
  let currentFiles: string[] = []

  async function updatePicker(query: string) {
    try {
      currentFiles = await api.index.query(query)
    } catch {
      currentFiles = []
    }

    picker.innerHTML = ''
    selectedIdx = 0
    currentFiles.forEach((path, i) => {
      const item = document.createElement('div')
      item.className = `mention-item${i === 0 ? ' selected' : ''}`
      item.setAttribute('role', 'option')
      item.textContent = path
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        void selectItem(i)
      })
      picker.append(item)
    })
    picker.hidden = currentFiles.length === 0
  }

  async function selectItem(idx: number) {
    const path = currentFiles[idx]
    if (!path) {
      hidePicker()
      return
    }
    try {
      const content = await api.fs.readFile(path)
      onAttach({ path, content })
    } catch {
      /* ignore read errors */
    }
    const val = textarea.value
    textarea.value = val.slice(0, mentionStart) + val.slice(textarea.selectionStart)
    hidePicker()
  }

  function hidePicker() {
    picker.hidden = true
    mentionStart = -1
  }

  function updateSelection() {
    picker
      .querySelectorAll('.mention-item')
      .forEach((el, i) => el.classList.toggle('selected', i === selectedIdx))
  }

  textarea.addEventListener('input', () => {
    const val = textarea.value
    const cursor = textarea.selectionStart
    const atIdx = val.lastIndexOf('@', cursor - 1)
    if (atIdx === -1 || val.slice(atIdx + 1, cursor).includes(' ')) {
      hidePicker()
      return
    }
    mentionStart = atIdx
    void updatePicker(val.slice(atIdx + 1, cursor))
  })

  textarea.addEventListener('keydown', (e) => {
    if (picker.hidden) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = Math.min(selectedIdx + 1, currentFiles.length - 1)
      updateSelection()
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = Math.max(selectedIdx - 1, 0)
      updateSelection()
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
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
