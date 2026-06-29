// Verifies the Cmd/Ctrl+P quick-open palette: it mounts as a native <dialog>,
// renders matches from api.index.query as the user types, and opens the chosen
// file in the explorer (openWorkspaceFile → store state + reveal events).
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — same approach as the settings-dialog test.
// Real top-layer behaviour (focus trap, Esc-to-close) is covered by Chromium e2e.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  mountFileSearchDialog,
  openFileSearchDialog,
  closeFileSearchDialog,
  isFileSearchDialogOpen,
} from './file-search-dialog.ts'

function shimModal(dialog: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: () => void (open = true) },
    close: { configurable: true, value: () => void (open = false) },
    open: { configurable: true, get: () => open },
  })
}

interface ApiCalls {
  queries: string[]
  reads: string[]
}

// Minimal api with a controllable file index + file reader. queryResult lets a
// test swap what the next index.query resolves to.
function stubApi(calls: ApiCalls, queryResult: () => string[]): ApiClient {
  const api = {
    index: {
      query: (pattern: string): Promise<string[]> => {
        calls.queries.push(pattern)
        return Promise.resolve(queryResult())
      },
    },
    fs: {
      readFile: (path: string): Promise<string> => {
        calls.reads.push(path)
        return Promise.resolve(`contents of ${path}`)
      },
    },
  }
  return api as unknown as ApiClient
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('file search dialog (Cmd/Ctrl+P quick open)', () => {
  let dialog: HTMLDialogElement
  let calls: ApiCalls
  let store: ReturnType<typeof createStore>
  let result: string[]

  beforeEach(() => {
    document.body.innerHTML = ''
    calls = { queries: [], reads: [] }
    result = ['src/main.ts', 'src/renderer/views/file-tree.ts']
    store = createStore()
    mountFileSearchDialog(
      store,
      stubApi(calls, () => result),
    )
    dialog = document.getElementById('file-search-dialog') as HTMLDialogElement
    shimModal(dialog)
  })

  it('mounts as a native dialog, initially closed', () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isFileSearchDialogOpen(), false)
  })

  it('opens, seeds the index, and renders a row per match', async () => {
    openFileSearchDialog()
    assert.equal(isFileSearchDialogOpen(), true)
    await tick(0) // let the seed query (no debounce) resolve and render
    const items = dialog.querySelectorAll('.file-search-item')
    assert.equal(items.length, 2)
    // Filename and directory are split into separate cells.
    assert.equal(items[0]!.querySelector('.file-search-name')!.textContent, 'main.ts')
    assert.equal(items[0]!.querySelector('.file-search-dir')!.textContent, 'src')
    // First row is selected by default.
    assert.ok(items[0]!.classList.contains('selected'))
  })

  it('queries the index as the user types (debounced)', async () => {
    openFileSearchDialog()
    await tick(0)
    const input = dialog.querySelector('.file-search-input') as HTMLInputElement
    result = ['src/renderer/views/file-tree.ts']
    input.value = 'tree'
    input.dispatchEvent(new Event('input'))
    await tick(150) // past the 100ms debounce
    assert.ok(calls.queries.includes('tree'))
    const items = dialog.querySelectorAll('.file-search-item')
    assert.equal(items.length, 1)
    assert.equal(items[0]!.querySelector('.file-search-name')!.textContent, 'file-tree.ts')
  })

  it('shows an empty state when nothing matches', async () => {
    result = []
    openFileSearchDialog()
    await tick(0)
    assert.equal(dialog.querySelectorAll('.file-search-item').length, 0)
    const empty = dialog.querySelector('.file-search-empty') as HTMLElement
    assert.equal(empty.hidden, false)
  })

  it('opening a match reads the file, reveals the explorer, and closes', async () => {
    openFileSearchDialog()
    await tick(0)
    const second = dialog.querySelectorAll('.file-search-item')[1] as HTMLElement
    second.dispatchEvent(new Event('mousedown'))
    await tick(0)
    // openWorkspaceFile read the chosen path and pushed it into the explorer.
    assert.deepEqual(calls.reads, ['src/renderer/views/file-tree.ts'])
    assert.equal(store.getState().openFile?.path, 'src/renderer/views/file-tree.ts')
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(isFileSearchDialogOpen(), false)
  })

  it('close() is a no-op when already closed', () => {
    closeFileSearchDialog()
    assert.equal(isFileSearchDialogOpen(), false)
  })
})
