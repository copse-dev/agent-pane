import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountRoadmapPane } from './roadmap-pane.ts'

// Minimal KnowledgeNote (Roadmap) factory; only the fields the pane reads matter.
function makeItem(
  id: string,
  prompt: string,
  status = 'ready',
  notes?: string,
  issue?: string,
  complexity?: string,
): {
  id: string
  type: string
  title: string
  body: string
  tags: string[]
  status: string
  fields: Record<string, string>
  createdAt: string
  updatedAt: string
  file: string
} {
  return {
    id,
    type: 'Roadmap',
    title: prompt.slice(0, 80),
    body: prompt,
    tags: [],
    status,
    fields: {
      ...(notes ? { notes } : {}),
      ...(issue ? { issue } : {}),
      ...(complexity ? { complexity } : {}),
    },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    file: `/tmp/${id}.md`,
  }
}

interface RoadmapCalls {
  list: number
  create: { prompt: string; notes: string | undefined; issue: string | undefined }[]
  update: {
    id: string
    prompt: string
    notes: string | undefined
    status: string
    issue: string | undefined
  }[]
  delete: string[]
  issueUrl: string[]
  openExternal: string[]
  openIssues: number
  importIssues: { number: number; title: string; body: string }[][]
}

interface MockOpenIssue {
  owner: string
  repo: string
  number: number
  title: string
  url: string
  body: string
  labels: string[]
}

function makeOpenIssue(number: number, title: string, body = ''): MockOpenIssue {
  return {
    owner: 'octo',
    repo: 'demo',
    number,
    title,
    url: `https://github.com/octo/demo/issues/${String(number)}`,
    body,
    labels: [],
  }
}

/** A fake api whose roadmap methods mutate an in-memory list, like the store. */
function makeApi(
  seed: ReturnType<typeof makeItem>[],
  issues: MockOpenIssue[] = [],
): { api: ApiClient; calls: RoadmapCalls } {
  const items = seed.map((i) => ({ ...i }))
  const calls: RoadmapCalls = {
    list: 0,
    create: [],
    update: [],
    delete: [],
    issueUrl: [],
    openExternal: [],
    openIssues: 0,
    importIssues: [],
  }
  const api = {
    panes: { popout: async (): Promise<void> => {} },
    shell: {
      openExternal: async (url: string): Promise<void> => {
        calls.openExternal.push(url)
      },
    },
    roadmap: {
      list: async () => {
        calls.list++
        return items.map((i) => ({ ...i }))
      },
      create: async (prompt: string, notes?: string, issue?: string) => {
        calls.create.push({ prompt, notes, issue })
        const item = makeItem(`new-${String(items.length)}`, prompt, 'ready', notes, issue)
        items.push(item)
        return item
      },
      update: async (
        id: string,
        prompt: string,
        notes: string | undefined,
        status: string,
        issue?: string,
      ) => {
        calls.update.push({ id, prompt, notes, status, issue })
        const item = items.find((i) => i.id === id)
        if (!item) return null
        item.title = prompt.slice(0, 80)
        item.body = prompt
        item.status = status
        item.fields = { ...(notes ? { notes } : {}), ...(issue ? { issue } : {}) }
        return { ...item }
      },
      delete: async (id: string) => {
        calls.delete.push(id)
        const i = items.findIndex((n) => n.id === id)
        if (i >= 0) items.splice(i, 1)
        return i >= 0
      },
      issueUrl: async (ref: string) => {
        calls.issueUrl.push(ref)
        return `https://github.com/octo/demo/issues/${ref.replace('#', '')}`
      },
      openIssues: async () => {
        calls.openIssues++
        return issues.map((i) => ({ ...i }))
      },
      importIssues: async (selected: { number: number; title: string; body: string }[]) => {
        calls.importIssues.push(selected)
        const created = selected.map((s) =>
          makeItem(
            `imported-${String(s.number)}`,
            `Resolve GitHub issue #${String(s.number)}: ${s.title}`,
            'ready',
            `Imported from issue #${String(s.number)}: ${s.title}`,
            `#${String(s.number)}`,
          ),
        )
        items.push(...created)
        return created
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

describe('roadmap pane', () => {
  it('lists items with their status badges when mounted with the pane active', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([
      makeItem('a', 'Refactor the settings dialog', 'ready'),
      makeItem('b', 'Port e2e specs', 'blocked', 'waiting on PR #400'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(calls.list, 1, 'fetches the roadmap on active mount')
      const titles = [...list.querySelectorAll('.roadmap-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['Refactor the settings dialog', 'Port e2e specs'])
      const badges = [...list.querySelectorAll('.roadmap-status-badge')].map((e) => e.textContent)
      assert.deepEqual(badges, ['ready', 'blocked'])
      assert.ok(list.querySelector('.roadmap-status-badge.is-blocked'), 'status styles the badge')
    } finally {
      unmount()
    }
  })

  it('does not fetch when the pane is inactive on mount', async () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const { api, calls } = makeApi([makeItem('a', 'X')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(calls.list, 0)
    } finally {
      unmount()
    }
  })

  it('opens an item in the editor, including notes and status', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Do the thing', 'blocked', 'after #99 merges')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      const notes = viewer.querySelector<HTMLInputElement>('.roadmap-notes-input')
      const status = viewer.querySelector<HTMLSelectElement>('.roadmap-status-select')
      assert.ok(prompt && notes && status)
      assert.equal(prompt.value, 'Do the thing')
      assert.equal(notes.value, 'after #99 merges')
      assert.equal(status.value, 'blocked')
      // Status and Delete are offered for an existing item.
      assert.equal(status.hidden, false)
      assert.equal(viewer.querySelector<HTMLButtonElement>('.roadmap-delete-btn')?.hidden, false)
    } finally {
      unmount()
    }
  })

  it('creates a new item from the blank form (status control hidden)', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      const notes = viewer.querySelector<HTMLInputElement>('.roadmap-notes-input')
      const status = viewer.querySelector<HTMLSelectElement>('.roadmap-status-select')
      assert.ok(prompt && notes && status)
      // New items always start `ready`: no status control, no Delete.
      assert.equal(status.hidden, true)
      assert.equal(viewer.querySelector<HTMLButtonElement>('.roadmap-delete-btn')?.hidden, true)
      prompt.value = 'Add dark-mode screenshots to CI'
      notes.value = 'idea from review'
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.create, [
        { prompt: 'Add dark-mode screenshots to CI', notes: 'idea from review', issue: undefined },
      ])
      const titles = [...list.querySelectorAll('.roadmap-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['Add dark-mode screenshots to CI'], 'the new item appears')
    } finally {
      unmount()
    }
  })

  it('rejects saving a blank prompt', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.equal(calls.create.length, 0)
      assert.equal(viewer.querySelector<HTMLElement>('.memories-error')?.hidden, false)
    } finally {
      unmount()
    }
  })

  it('saves prompt and status edits to an existing item', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Old prompt', 'ready')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      const status = viewer.querySelector<HTMLSelectElement>('.roadmap-status-select')
      assert.ok(prompt && status)
      prompt.value = 'New prompt'
      status.value = 'done'
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.update, [
        { id: 'a', prompt: 'New prompt', notes: undefined, status: 'done', issue: undefined },
      ])
      const badges = [...list.querySelectorAll('.roadmap-status-badge')].map((e) => e.textContent)
      assert.deepEqual(badges, ['done'])
    } finally {
      unmount()
    }
  })

  it('deletes the selected item after confirmation', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Doomed')])
    const { list, viewer } = mountHosts()
    const priorConfirm = globalThis.confirm
    globalThis.confirm = (): boolean => true
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      viewer.querySelector<HTMLButtonElement>('.roadmap-delete-btn')?.click()
      await flush()
      assert.deepEqual(calls.delete, ['a'])
      assert.equal(list.querySelectorAll('.roadmap-row').length, 0)
      // With nothing selected, the editor falls back to its empty state.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-empty')?.hidden, false)
    } finally {
      globalThis.confirm = priorConfirm
      unmount()
    }
  })

  it('shows a complexity badge for stamped items and none for legacy values', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([
      makeItem('a', 'Big refactor', 'ready', undefined, undefined, 'high'),
      makeItem('b', 'Unstamped'),
      makeItem('c', 'Bad value', 'ready', undefined, undefined, 'frontier'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const badges = [...list.querySelectorAll('.roadmap-complexity-badge')]
      assert.equal(badges.length, 1, 'only the valid stamp renders')
      const badge = badges[0]
      assert.ok(badge)
      assert.equal(badge.textContent, 'high')
      assert.ok(badge.classList.contains('is-high'))
    } finally {
      unmount()
    }
  })

  it('renders a pinned issue as a chip that opens on GitHub without selecting', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Fix the flaky test', 'ready', undefined, '#42')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const chip = list.querySelector<HTMLElement>('.roadmap-issue-chip')
      assert.ok(chip)
      assert.equal(chip.textContent, '#42')
      chip.click()
      await flush()
      assert.deepEqual(calls.issueUrl, ['#42'])
      assert.deepEqual(calls.openExternal, ['https://github.com/octo/demo/issues/42'])
      // The chip click must not select the row into the editor.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-empty')?.hidden, false)
    } finally {
      unmount()
    }
  })

  it('saves the pinned issue with edits', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Do the thing')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const issue = viewer.querySelector<HTMLInputElement>('.roadmap-issue-input')
      assert.ok(issue)
      issue.value = '#77'
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.equal(calls.update[0]?.issue, '#77')
      assert.equal(list.querySelector<HTMLElement>('.roadmap-issue-chip')?.textContent, '#77')
    } finally {
      unmount()
    }
  })

  it('starts a new thread with the composer draft pre-filled from the item', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Ship the thing', 'ready', 'after #99 merges')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const startBtn = viewer.querySelector<HTMLButtonElement>('.roadmap-start-btn')
      assert.ok(startBtn)
      assert.equal(startBtn.hidden, false, 'offered for an existing item')
      let opened = 0
      store.on('new_thread_opened', () => opened++)
      startBtn.click()
      assert.equal(opened, 1, 'opens a new thread')
      const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
      assert.equal(thread?.draftPrompt, 'Ship the thing\n\nNotes: after #99 merges')
    } finally {
      unmount()
    }
  })

  it('hides the start-thread button on a blank new-item form', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      assert.equal(viewer.querySelector<HTMLButtonElement>('.roadmap-start-btn')?.hidden, true)
    } finally {
      unmount()
    }
  })

  it('imports selected open issues as pinned roadmap items', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi(
      [makeItem('a', 'Existing item', 'ready', undefined, '#41')],
      [makeOpenIssue(41, 'Already pinned issue'), makeOpenIssue(52, 'Terminal shortcut', 'Body')],
    )
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-import-btn')?.click()
      await flush()
      assert.equal(calls.openIssues, 1)
      const checks = [...viewer.querySelectorAll<HTMLInputElement>('.roadmap-import-check')]
      assert.equal(checks.length, 2)
      const [pinnedCheck, freeCheck] = checks
      assert.ok(pinnedCheck && freeCheck)
      // The issue already pinned by an existing item cannot be re-imported.
      assert.equal(pinnedCheck.disabled, true)
      assert.equal(freeCheck.disabled, false)
      freeCheck.click()
      viewer.querySelector<HTMLButtonElement>('.roadmap-import-confirm')?.click()
      await flush()
      assert.deepEqual(calls.importIssues, [
        [{ number: 52, title: 'Terminal shortcut', body: 'Body' }],
      ])
      const titles = [...list.querySelectorAll('.roadmap-row-title')].map((e) => e.textContent)
      assert.ok(titles.join('\n').includes('#52'), 'the imported item appears in the list')
      // The picker closes after a successful import.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-import')?.hidden, true)
    } finally {
      unmount()
    }
  })

  it('requires a selection before importing', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([], [makeOpenIssue(52, 'Terminal shortcut')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-import-btn')?.click()
      await flush()
      viewer.querySelector<HTMLButtonElement>('.roadmap-import-confirm')?.click()
      await flush()
      assert.equal(calls.importIssues.length, 0)
      assert.match(
        viewer.querySelector('.roadmap-import-status')?.textContent ?? '',
        /Select at least one issue/,
      )
    } finally {
      unmount()
    }
  })

  it('does not discard an in-progress edit on a background refresh', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Old prompt')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      assert.ok(prompt)
      // User is mid-edit...
      prompt.value = 'Half-typed new prompt'
      // ...when a background store event fires (e.g. the staged-diff queue drains).
      store.emit('files_pane_changed')
      await flush()
      // The draft must survive rather than being overwritten with the stored item.
      assert.equal(
        viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')?.value,
        'Half-typed new prompt',
      )
    } finally {
      unmount()
    }
  })
})
