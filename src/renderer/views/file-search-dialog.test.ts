// Verifies the Cmd/Ctrl+P quick-open palette: it mounts as a native <dialog>,
// renders matches from api.index.query as the user types, and opens the chosen
// file in the explorer (openWorkspaceFile → store state + reveal events). It is
// also a light "search everywhere": roadmap items matching the query render in
// a labelled section beneath the files, and choosing one opens the Roadmap pane
// with that item selected (navigateToRoadmapItem → roadmap_reveal).
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — same approach as the settings-dialog test.
// Real top-layer behaviour (focus trap, Esc-to-close) is covered by Chromium e2e.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import {
  mountFileSearchDialog,
  openFileSearchDialog,
  closeFileSearchDialog,
  isFileSearchDialogOpen,
} from './file-search-dialog.ts'
import { qsRequired } from '../dom/helpers.ts'

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
  roadmapLists: number
}

/** Minimal roadmap KnowledgeNote; only the fields the palette reads matter. */
function makeRoadmapItem(
  id: string,
  prompt: string,
  status = 'ready',
  notes?: string,
): Record<string, unknown> {
  return {
    id,
    type: 'Roadmap',
    title: prompt.slice(0, 80),
    body: prompt,
    tags: [],
    status,
    fields: notes ? { notes } : {},
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    file: `/tmp/${id}.md`,
  }
}

// Minimal api with a controllable file index + file reader + roadmap store.
// queryResult lets a test swap what the next index.query resolves to; roadmap
// accepts a thunk so a test can hand out unresolved promises (fetch races).
function stubApi(
  calls: ApiCalls,
  queryResult: () => string[],
  options?: {
    roadmap?: Record<string, unknown>[] | (() => Promise<Record<string, unknown>[]>)
    roadmapEnabled?: boolean
  },
): ApiClient {
  const api = {
    index: {
      query: (pattern: string): Promise<string[]> => {
        calls.queries.push(pattern)
        return Promise.resolve(queryResult())
      },
    },
    fs: {
      readFile: (_projectId: string, _threadId: string, path: string): Promise<string> => {
        calls.reads.push(path)
        return Promise.resolve(`contents of ${path}`)
      },
    },
    settings: {
      get: (): Promise<unknown> => Promise.resolve(null),
    },
    packs: {
      // Roadmap is gated by the `copse.roadmap-plans` pack; the dialog reads
      // enablement from `packs:list` (mirrors the pane's titlebar-button gate).
      list: (): Promise<{ packs: { id: string; enabled: boolean }[] }> =>
        Promise.resolve({
          packs: [{ id: ROADMAP_PLANS_PACK_ID, enabled: options?.roadmapEnabled ?? false }],
        }),
    },
    roadmap: {
      list: (): Promise<Record<string, unknown>[]> => {
        calls.roadmapLists++
        const items = options?.roadmap
        return typeof items === 'function' ? items() : Promise.resolve(items ?? [])
      },
    },
  }
  return api as unknown as ApiClient
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function at<T>(list: ArrayLike<T>, i: number): T {
  const value = list[i]
  if (value === undefined) throw new Error(`expected element at index ${String(i)}`)
  return value
}

function requireQuery(root: Element, selector: string): Element {
  const found = root.querySelector(selector)
  if (!found) throw new Error(`expected element matching '${selector}'`)
  return found
}

describe('file search dialog (Cmd/Ctrl+P quick open)', () => {
  let dialog: HTMLDialogElement
  let calls: ApiCalls
  let store: ReturnType<typeof createStore>
  let result: string[]

  function mount(options?: {
    roadmap?: Record<string, unknown>[] | (() => Promise<Record<string, unknown>[]>)
    roadmapEnabled?: boolean
  }): void {
    document.body.innerHTML = ''
    calls = { queries: [], reads: [], roadmapLists: 0 }
    store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    mountFileSearchDialog(
      store,
      stubApi(calls, () => result, options),
    )
    dialog = qsRequired<HTMLDialogElement>(document, '#file-search-dialog')
    shimModal(dialog)
  }

  beforeEach(() => {
    result = ['src/main.ts', 'src/renderer/views/file-tree.ts']
    mount()
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
    assert.equal(requireQuery(at(items, 0), '.file-search-name').textContent, 'main.ts')
    assert.equal(requireQuery(at(items, 0), '.file-search-dir').textContent, 'src')
    // First row is selected by default.
    assert.ok(at(items, 0).classList.contains('selected'))
  })

  it('queries the index as the user types (debounced)', async () => {
    openFileSearchDialog()
    await tick(0)
    const input = qsRequired<HTMLInputElement>(dialog, '.file-search-input')
    result = ['src/renderer/views/file-tree.ts']
    input.value = 'tree'
    input.dispatchEvent(new Event('input'))
    await tick(150) // past the 100ms debounce
    assert.ok(calls.queries.includes('tree'))
    const items = dialog.querySelectorAll('.file-search-item')
    assert.equal(items.length, 1)
    assert.equal(requireQuery(at(items, 0), '.file-search-name').textContent, 'file-tree.ts')
  })

  it('shows an empty state when nothing matches', async () => {
    result = []
    openFileSearchDialog()
    await tick(0)
    assert.equal(dialog.querySelectorAll('.file-search-item').length, 0)
    const empty = qsRequired(dialog, '.file-search-empty')
    assert.equal(empty.hidden, false)
  })

  it('opening a match reads the file, reveals the explorer, and closes', async () => {
    openFileSearchDialog()
    await tick(0)
    const second = dialog.querySelectorAll<HTMLElement>('.file-search-item').item(1)
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

  describe('roadmap results (search everywhere)', () => {
    const roadmap = [
      makeRoadmapItem('r1', 'Polish the onboarding flow', 'ready'),
      makeRoadmapItem('r2', 'Port the e2e suite', 'blocked', 'waiting on onboarding rework'),
      makeRoadmapItem('r3', 'Ship dark-mode themes', 'done'),
    ]

    async function typeQuery(query: string): Promise<void> {
      const input = qsRequired<HTMLInputElement>(dialog, '.file-search-input')
      input.value = query
      input.dispatchEvent(new Event('input'))
      await tick(150) // past the 100ms debounce
    }

    it('renders matching roadmap items in a labelled section after the files', async () => {
      mount({ roadmap, roadmapEnabled: true })
      result = ['docs/onboarding.md']
      openFileSearchDialog()
      await tick(0)
      await typeQuery('onboarding')
      const section = dialog.querySelector('.file-search-section')
      assert.equal(section?.textContent, 'Roadmap')
      const rows = dialog.querySelectorAll('.file-search-roadmap-item')
      // r1 matches on the prompt, r2 on its notes field, r3 not at all.
      assert.equal(rows.length, 2)
      assert.equal(
        requireQuery(at(rows, 0), '.file-search-name').textContent,
        'Polish the onboarding flow',
      )
      // Default `ready` is silent in the palette (same rule as the Roadmap list).
      assert.equal(at(rows, 0).querySelector('.roadmap-status-badge'), null)
      // The section sits after the file rows: file first in the flat list.
      const all = dialog.querySelectorAll('.file-search-item')
      assert.equal(all.length, 3)
      assert.ok(at(all, 0).classList.contains('selected'))
      assert.equal(requireQuery(at(all, 0), '.file-search-name').textContent, 'onboarding.md')
    })

    it('choosing a roadmap item opens the Roadmap pane with it selected', async () => {
      mount({ roadmap, roadmapEnabled: true })
      result = []
      const revealed: string[] = []
      store.on('roadmap_reveal', (id) => revealed.push(id))
      openFileSearchDialog()
      await tick(0)
      await typeQuery('e2e suite')
      const row = qsRequired(dialog, '.file-search-roadmap-item')
      assert.ok(row, 'expected a roadmap result row')
      row.dispatchEvent(new Event('mousedown'))
      await tick(0)
      assert.equal(isFileSearchDialogOpen(), false)
      assert.equal(store.getState().rightPanelMode, 'roadmap')
      assert.equal(store.getState().filesPaneOpen, true)
      assert.deepEqual(revealed, ['r2'])
      // No file read happened — the entry routed to the pane, not the explorer.
      assert.deepEqual(calls.reads, [])
    })

    it('shows no roadmap section for the empty seed query', async () => {
      mount({ roadmap, roadmapEnabled: true })
      openFileSearchDialog()
      await tick(0)
      assert.equal(dialog.querySelector('.file-search-section'), null)
      assert.equal(dialog.querySelectorAll('.file-search-roadmap-item').length, 0)
    })

    it('drops the previous open’s items while a reopen’s fetch is pending', async () => {
      // Hand each open an explicitly-resolvable fetch so the race is
      // deterministic: reopen before resolving and the stale snapshot
      // (possibly another workspace's) must not render.
      let resolveList: ((items: Record<string, unknown>[]) => void) | undefined
      mount({
        roadmapEnabled: true,
        roadmap: () =>
          new Promise<Record<string, unknown>[]>((resolve) => {
            resolveList = resolve
          }),
      })
      result = []
      openFileSearchDialog()
      await tick(0)
      resolveList?.(roadmap) // first open's fetch lands
      await typeQuery('onboarding')
      assert.equal(dialog.querySelectorAll('.file-search-roadmap-item').length, 2)

      closeFileSearchDialog()
      openFileSearchDialog() // second open: its fetch stays pending
      await tick(0)
      await typeQuery('onboarding')
      assert.equal(
        dialog.querySelectorAll('.file-search-roadmap-item').length,
        0,
        'stale items from the previous open must not render',
      )
      resolveList?.([]) // the fresh (empty) snapshot lands and re-runs the query
      await tick(0)
      assert.equal(dialog.querySelectorAll('.file-search-roadmap-item').length, 0)
    })

    it('never lists roadmap items while the roadmap feature is disabled', async () => {
      mount({ roadmap, roadmapEnabled: false })
      result = []
      openFileSearchDialog()
      await tick(0)
      await typeQuery('onboarding')
      assert.equal(calls.roadmapLists, 0, 'must not fetch the roadmap when disabled')
      assert.equal(dialog.querySelectorAll('.file-search-roadmap-item').length, 0)
      const empty = qsRequired(dialog, '.file-search-empty')
      assert.equal(empty.hidden, false)
    })
  })
})
