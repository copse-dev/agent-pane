// Verifies the Cmd/Ctrl+Shift+K command palette: it mounts as a native <dialog>,
// seeds threads across every project from api.threads.catalog on open, and
// filters threads / projects / panels / commands as the user types. Choosing a
// panel row opens that right-panel mode and closes the palette.
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — same approach as the file-search-dialog test.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread, ThreadCatalogHit } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  mountCommandPalette,
  openCommandPalette,
  closeCommandPalette,
  isCommandPaletteOpen,
} from './command-palette.ts'

function shimModal(dialog: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: () => void (open = true) },
    close: { configurable: true, value: () => void (open = false) },
    open: { configurable: true, get: () => open },
  })
}

// The real catalog type, not a hand-rolled subset. The previous local interface
// omitted `spinePath` and only compiled because the ApiClient double was cast;
// using ThreadCatalogHit keeps the double honest about what the API returns.
function hit(id: string, title: string, updatedAt: number): ThreadCatalogHit {
  return {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    digest: '',
    path: `/tmp/${id}`,
    spinePath: `/tmp/${id}/spine.json`,
  }
}

// Per-project thread catalog keyed by project id; api.threads.catalog reads it.
// Built by overriding one method on the browser demo's real ApiClient rather
// than casting a partial literal, so the double stays type-safe and adds nothing
// to the lint-suppression baseline.
function stubApi(catalog: Record<string, ThreadCatalogHit[]>): ApiClient {
  const api = createFakeApi()
  return {
    ...api,
    threads: {
      ...api.threads,
      catalog: (projectId: string): Promise<ThreadCatalogHit[]> =>
        Promise.resolve(catalog[projectId] ?? []),
    },
  }
}

/** Query helper: asserts presence instead of asserting the type. */
function must(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  assert.ok(found, `expected to find ${selector}`)
  return found
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function project(id: string, name: string): Project {
  return { id, path: `/repos/${id}`, name }
}

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function rowTexts(dialog: HTMLElement, kind: string): string[] {
  return [...dialog.querySelectorAll(`.command-palette-item-${kind} .command-palette-name`)].map(
    (n) => n.textContent,
  )
}

function type(dialog: HTMLElement, value: string): void {
  const input = dialog.querySelector<HTMLInputElement>('.command-palette-input')
  assert.ok(input, 'expected the palette input')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('command palette (Cmd/Ctrl+Shift+K)', () => {
  let dialog: HTMLDialogElement
  let store: ReturnType<typeof createStore>

  function mount(catalog: Record<string, ThreadCatalogHit[]>): void {
    document.body.innerHTML = ''
    store = createStore()
    store.setState({
      workspaceRoot: '/repos/app',
      projects: [project('app', 'app'), project('site', 'site')],
      activeProjectId: 'app',
      threads: [thread('t-live', 'Live active thread')],
    })
    mountCommandPalette(store, stubApi(catalog))
    const found = document.querySelector<HTMLDialogElement>('#command-palette-dialog')
    assert.ok(found, 'expected the palette dialog')
    dialog = found
    shimModal(dialog)
  }

  beforeEach(() => {
    mount({
      app: [hit('t1', 'Fix login bug', 30), hit('t2', 'Refactor sidebar', 10)],
      site: [hit('t3', 'Landing page copy', 20)],
    })
  })

  it('mounts as a native dialog, initially closed', () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isCommandPaletteOpen(), false)
  })

  it('opens and seeds threads from every project, newest first', async () => {
    openCommandPalette()
    assert.equal(isCommandPaletteOpen(), true)
    await tick(0) // let the catalog fetch resolve and re-render
    // Catalog hits sorted by updatedAt desc across both projects, then the live
    // active-project thread (not in the catalog) appended so it never vanishes.
    assert.deepEqual(rowTexts(dialog, 'thread'), [
      'Fix login bug',
      'Landing page copy',
      'Refactor sidebar',
      'Live active thread',
    ])
    // Projects, panels, and commands all render their own sections.
    assert.deepEqual(rowTexts(dialog, 'project'), ['app', 'site'])
    assert.ok(rowTexts(dialog, 'panel').includes('Terminal'))
    assert.ok(rowTexts(dialog, 'command').includes('Settings'))
    // Sections are labelled.
    const sections = [...dialog.querySelectorAll('.command-palette-section')].map(
      (n) => n.textContent,
    )
    assert.deepEqual(sections, ['Threads', 'Projects', 'Panels', 'Commands'])
  })

  it('keeps live active-project threads when the catalog is empty', async () => {
    // A freshly-opened workspace whose on-disk catalog has not been built yet:
    // catalog() returns nothing, but the store already holds the active thread.
    mount({})
    openCommandPalette()
    await tick(0)
    assert.deepEqual(rowTexts(dialog, 'thread'), ['Live active thread'])
  })

  it('filters every section by the query', async () => {
    openCommandPalette()
    await tick(0)
    type(dialog, 'login')
    assert.deepEqual(rowTexts(dialog, 'thread'), ['Fix login bug'])
    assert.deepEqual(rowTexts(dialog, 'project'), [])
    assert.deepEqual(rowTexts(dialog, 'panel'), [])
    assert.deepEqual(rowTexts(dialog, 'command'), [])
  })

  it('matches a thread by its project name too', async () => {
    openCommandPalette()
    await tick(0)
    type(dialog, 'site')
    // The 'site' thread matches on project name; the 'site' project matches too.
    assert.deepEqual(rowTexts(dialog, 'thread'), ['Landing page copy'])
    assert.deepEqual(rowTexts(dialog, 'project'), ['site'])
  })

  it('shows an empty state when nothing matches', async () => {
    openCommandPalette()
    await tick(0)
    type(dialog, 'zzzznomatch')
    assert.equal(dialog.querySelectorAll('.command-palette-item').length, 0)
    assert.equal(must(dialog, '.command-palette-empty').hidden, false)
  })

  it('choosing a panel opens that right-panel mode and closes', async () => {
    openCommandPalette()
    await tick(0)
    type(dialog, 'terminal')
    const row = must(dialog, '.command-palette-item-panel')
    row.dispatchEvent(new Event('mousedown'))
    assert.equal(store.getState().rightPanelMode, 'terminal')
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(isCommandPaletteOpen(), false)
  })

  it('omits workspace-only commands when there is no workspace', async () => {
    mount({})
    store.setState({ workspaceRoot: null, projects: [], activeProjectId: null, threads: [] })
    openCommandPalette()
    await tick(0)
    const commands = rowTexts(dialog, 'command')
    assert.ok(!commands.includes('New thread'), 'New thread needs a workspace')
    assert.ok(commands.includes('Settings'), 'Settings is always available')
  })

  it('close() is a no-op when already closed', () => {
    closeCommandPalette()
    assert.equal(isCommandPaletteOpen(), false)
  })
})
