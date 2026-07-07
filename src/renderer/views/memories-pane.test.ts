import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountMemoriesPane } from './memories-pane.ts'

// Minimal KnowledgeNote (Memory) factory; only the fields the pane reads matter.
function makeNote(id: string, title: string, body: string, tags: string[] = []): unknown {
  return {
    id,
    type: 'Memory',
    title,
    body,
    tags,
    status: null,
    fields: {},
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    file: `/tmp/${id}.md`,
  }
}

interface MemoryCalls {
  list: number
  create: { title: string; body: string; tags: string[] | undefined }[]
  update: { id: string; title: string; body: string; tags: string[] | undefined }[]
  delete: string[]
}

/** A fake api whose memories methods mutate an in-memory list, like the store. */
function makeApi(seed: ReturnType<typeof makeNote>[]): { api: ApiClient; calls: MemoryCalls } {
  const notes = [...seed] as { id: string; title: string; body: string; tags: string[] }[]
  const calls: MemoryCalls = { list: 0, create: [], update: [], delete: [] }
  const api = {
    panes: { popout: async (): Promise<void> => {} },
    memories: {
      list: async () => {
        calls.list++
        return notes.map((n) => ({ ...n }))
      },
      create: async (title: string, body: string, tags?: string[]) => {
        calls.create.push({ title, body, tags })
        const note = makeNote(`new-${String(notes.length)}`, title, body, tags ?? []) as {
          id: string
          title: string
          body: string
          tags: string[]
        }
        notes.push(note)
        return note
      },
      update: async (id: string, title: string, body: string, tags?: string[]) => {
        calls.update.push({ id, title, body, tags })
        const note = notes.find((n) => n.id === id)
        if (!note) return null
        note.title = title
        note.body = body
        note.tags = tags ?? []
        return { ...note }
      },
      delete: async (id: string) => {
        calls.delete.push(id)
        const i = notes.findIndex((n) => n.id === id)
        if (i >= 0) notes.splice(i, 1)
        return i >= 0
      },
    },
  } as unknown as ApiClient
  return { api, calls }
}

/** Flush enough microtasks for the pane's chained async refresh to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function mountHosts(): { list: HTMLElement; viewer: HTMLElement } {
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  return { list, viewer }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('memories pane', () => {
  it('lists memories when mounted with the pane already active', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api, calls } = makeApi([
      makeNote('a', 'Build command', 'Run npm build', ['ops']),
      makeNote('b', 'API key location', 'In .env'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(calls.list, 1, 'fetches memories on active mount')
      const titles = [...list.querySelectorAll('.memories-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['Build command', 'API key location'])
      assert.equal(list.querySelectorAll('.memories-tag').length, 1, 'renders the one tag')
    } finally {
      unmount()
    }
  })

  it('does not fetch when the pane is inactive on mount', async () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const { api, calls } = makeApi([makeNote('a', 'X', 'Y')])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(calls.list, 0)
    } finally {
      unmount()
    }
  })

  it('opens a memory in the editor when its row is clicked', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api } = makeApi([makeNote('a', 'Build command', 'Run npm build', ['ops', 'ci'])])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.memories-row')?.click()
      const title = viewer.querySelector<HTMLInputElement>('.memories-title-input')
      const tags = viewer.querySelector<HTMLInputElement>('.memories-tags-input')
      const body = viewer.querySelector<HTMLTextAreaElement>('.memories-body-input')
      assert.equal(title?.value, 'Build command')
      assert.equal(tags?.value, 'ops, ci')
      assert.equal(body?.value, 'Run npm build')
      // Delete is offered for an existing note.
      assert.equal(viewer.querySelector<HTMLButtonElement>('.memories-btn-danger')?.hidden, false)
    } finally {
      unmount()
    }
  })

  it('creates a new memory from the blank form', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api, calls } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.memories-new-btn')?.click()
      const title = viewer.querySelector<HTMLInputElement>('.memories-title-input')
      const tags = viewer.querySelector<HTMLInputElement>('.memories-tags-input')
      const body = viewer.querySelector<HTMLTextAreaElement>('.memories-body-input')
      assert.ok(title && tags && body)
      // A blank new-note form offers no Delete.
      assert.equal(viewer.querySelector<HTMLButtonElement>('.memories-btn-danger')?.hidden, true)
      title.value = 'New fact'
      tags.value = 'a, b'
      body.value = 'Body text'
      viewer.querySelector('.memories-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.create, [{ title: 'New fact', body: 'Body text', tags: ['a', 'b'] }])
      const titles = [...list.querySelectorAll('.memories-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['New fact'], 'the new memory appears in the list')
    } finally {
      unmount()
    }
  })

  it('saves edits to an existing memory', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api, calls } = makeApi([makeNote('a', 'Old title', 'Old body')])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.memories-row')?.click()
      const title = viewer.querySelector<HTMLInputElement>('.memories-title-input')
      assert.ok(title)
      title.value = 'New title'
      viewer.querySelector('.memories-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.equal(calls.update.length, 1)
      const upd = calls.update[0]
      assert.ok(upd)
      assert.equal(upd.id, 'a')
      assert.equal(upd.title, 'New title')
      const titles = [...list.querySelectorAll('.memories-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['New title'])
    } finally {
      unmount()
    }
  })

  it('deletes the selected memory after confirmation', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api, calls } = makeApi([makeNote('a', 'Doomed', 'bye')])
    const { list, viewer } = mountHosts()
    const priorConfirm = globalThis.confirm
    globalThis.confirm = (): boolean => true
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.memories-row')?.click()
      viewer.querySelector<HTMLButtonElement>('.memories-btn-danger')?.click()
      await flush()
      assert.deepEqual(calls.delete, ['a'])
      assert.equal(list.querySelectorAll('.memories-row').length, 0)
      // With nothing selected, the editor falls back to its empty state.
      assert.equal(viewer.querySelector<HTMLElement>('.memories-empty')?.hidden, false)
    } finally {
      globalThis.confirm = priorConfirm
      unmount()
    }
  })

  it('does not discard an in-progress edit on a background refresh', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'memories' })
    const { api } = makeApi([makeNote('a', 'Title', 'Old body')])
    const { list, viewer } = mountHosts()
    const unmount = mountMemoriesPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.memories-row')?.click()
      const body = viewer.querySelector<HTMLTextAreaElement>('.memories-body-input')
      assert.ok(body)
      // User is mid-edit...
      body.value = 'Half-typed new body'
      // ...when a background store event fires (e.g. the staged-diff queue drains).
      store.emit('files_pane_changed')
      await flush()
      // The draft must survive rather than being overwritten with the stored note.
      assert.equal(
        viewer.querySelector<HTMLTextAreaElement>('.memories-body-input')?.value,
        'Half-typed new body',
      )
    } finally {
      unmount()
    }
  })
})
