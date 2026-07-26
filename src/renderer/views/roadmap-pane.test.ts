import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import { mountRoadmapPane } from './roadmap-pane.ts'
import { clickActiveConfirmDialogConfirm, mountConfirmDialog } from './confirm-dialog.ts'

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

interface MockAttachmentAdd {
  name: string
  mimeType: string
  dataUrl: string
}

/** Minimal persisted thread the pane's reopen path can resolve by id. */
function makeThread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

interface RoadmapCalls {
  list: number
  // `attachments` / `addAttachments` / `removeAttachmentIds` are recorded only
  // when the pane passed them, so the deepEqual assertions of attachment-free
  // saves stay byte-identical.
  create: {
    prompt: string
    notes: string | undefined
    issue: string | undefined
    attachments?: MockAttachmentAdd[]
  }[]
  update: {
    id: string
    prompt: string
    notes: string | undefined
    status: string
    issue: string | undefined
    addAttachments?: MockAttachmentAdd[]
    removeAttachmentIds?: string[]
  }[]
  attachmentData: string[]
  setStatus: { id: string; status: string }[]
  delete: string[]
  issueUrl: string[]
  openExternal: string[]
  openIssues: number
  importIssues: { number: number; title: string; body: string }[][]
  checkFit: string[]
  prepareReview: number
  reviewItem: { id: string; commits: string; runId?: string }[]
  reviewItemDeep: string[]
  lastReviewAt: number
  completeReview: string[]
  abortReview: string[]
  setThread: { id: string; threadId: string }[]
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
): {
  api: ApiClient
  calls: RoadmapCalls
  items: ReturnType<typeof makeItem>[]
  fireChanged: () => void
} {
  const items = seed.map((i) => ({ ...i }))
  let changedHandler: (() => void) | null = null
  const calls: RoadmapCalls = {
    list: 0,
    create: [],
    update: [],
    attachmentData: [],
    setStatus: [],
    delete: [],
    issueUrl: [],
    openExternal: [],
    openIssues: 0,
    importIssues: [],
    checkFit: [],
    prepareReview: 0,
    reviewItem: [],
    reviewItemDeep: [],
    lastReviewAt: 0,
    completeReview: [],
    abortReview: [],
    setThread: [],
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
      create: async (
        prompt: string,
        notes?: string,
        issue?: string,
        attachments?: MockAttachmentAdd[],
      ) => {
        calls.create.push({ prompt, notes, issue, ...(attachments ? { attachments } : {}) })
        const item = makeItem(`new-${String(items.length)}`, prompt, 'ready', notes, issue)
        if (attachments) {
          item.fields['attachments'] = JSON.stringify(
            attachments.map((a, i) => ({
              id: `att-new-${String(i)}`,
              name: a.name,
              mimeType: a.mimeType,
              size: 1,
            })),
          )
        }
        items.push(item)
        return item
      },
      update: async (
        id: string,
        prompt: string,
        notes: string | undefined,
        status: string,
        issue?: string,
        addAttachments?: MockAttachmentAdd[],
        removeAttachmentIds?: string[],
      ) => {
        calls.update.push({
          id,
          prompt,
          notes,
          status,
          issue,
          ...(addAttachments ? { addAttachments } : {}),
          ...(removeAttachmentIds ? { removeAttachmentIds } : {}),
        })
        const item = items.find((i) => i.id === id)
        if (!item) return null
        item.title = prompt.slice(0, 80)
        item.body = prompt
        item.status = status
        item.fields = { ...(notes ? { notes } : {}), ...(issue ? { issue } : {}) }
        return { ...item }
      },
      attachmentData: async (id: string, attachmentId: string) => {
        calls.attachmentData.push(`${id}/${attachmentId}`)
        return 'data:image/png;base64,QUJD'
      },
      setStatus: async (id: string, status: string) => {
        calls.setStatus.push({ id, status })
        const item = items.find((i) => i.id === id)
        if (!item) return null
        item.status = status
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
        return { slug: 'octo/demo', issues: issues.map((i) => ({ ...i })) }
      },
      checkFit: async (id: string) => {
        calls.checkFit.push(id)
        const item = items.find((i) => i.id === id)
        if (item) {
          item.fields = {
            ...item.fields,
            fit: 'partial',
            fitDetail: 'prompt does not mention the startup flash',
          }
        }
        return { verdict: 'partial', detail: '- prompt does not mention the startup flash' }
      },
      prepareReview: async () => {
        calls.prepareReview++
        // Mirror production: active items first, done items trailing.
        const scoped = items.filter((i) => i.status !== 'archived')
        const ordered = [
          ...scoped.filter((i) => i.status !== 'done'),
          ...scoped.filter((i) => i.status === 'done'),
        ]
        return {
          runId: 'bulk-run-1',
          since: null,
          commits: 'abc123 Fix startup flash',
          items: ordered.map((i) => ({ id: i.id, title: i.title })),
        }
      },
      reviewItem: async (id: string, commits: string, runId?: string) => {
        calls.reviewItem.push({ id, commits, ...(runId ? { runId } : {}) })
        const item = items.find((i) => i.id === id)
        if (item) {
          item.fields = {
            ...item.fields,
            reviewVerdict: 'likely',
            reviewDetail: 'Commit matches · Issue still open',
            reviewBulkRun: runId ?? 'bulk-run-1',
          }
        }
        return {
          id,
          verdict: 'likely' as const,
          detail: 'Commit matches · Issue still open',
          depth: 'bulk' as const,
          pinnedIssue: null,
          linkedIssues: [],
        }
      },
      reviewItemDeep: async (id: string) => {
        calls.reviewItemDeep.push(id)
        const item = items.find((i) => i.id === id)
        if (item) {
          item.fields = {
            ...item.fields,
            reviewVerdict: 'resolved',
            reviewDetail: 'Deep check · Issue closed',
            reviewDepth: 'deep',
            reviewBulkRun: 'bulk-run-1',
          }
        }
        return {
          id,
          verdict: 'resolved' as const,
          detail: 'Deep check · Issue closed',
          depth: 'deep' as const,
          pinnedIssue: null,
          linkedIssues: [],
        }
      },
      lastReviewAt: async () => {
        calls.lastReviewAt++
        return {
          lastReviewAt: '2026-07-15T00:00:00.000Z',
          lastAcknowledgedBulkRun: 'bulk-run-1',
          pendingBulkRun: null,
        }
      },
      completeReview: async (runId: string) => {
        calls.completeReview.push(runId)
        return true
      },
      abortReview: async (runId: string) => {
        calls.abortReview.push(runId)
        return true
      },
      setThread: async (id: string, threadId: string) => {
        calls.setThread.push({ id, threadId })
        const item = items.find((i) => i.id === id)
        if (!item) return null
        const { thread: _thread, ...rest } = item.fields
        item.fields = { ...rest, ...(threadId ? { thread: threadId } : {}) }
        return { ...item }
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
      onChanged: (handler: () => void) => {
        changedHandler = handler
        return (): void => {
          changedHandler = null
        }
      },
    },
  } as unknown as ApiClient
  return {
    api,
    calls,
    items,
    fireChanged: (): void => {
      changedHandler?.()
    },
  }
}

/** Flush enough microtasks for the pane's chained async refresh to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Poll until `cond` holds — attachment encoding hops through real timers
 * (File.arrayBuffer), which plain microtask flushing does not cover. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.ok(cond(), what)
}

/** Dispatch a paste of OS files, the way Chromium delivers a pasted image/file. */
function pasteFiles(target: Element, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.assign(event, { clipboardData: { files } })
  target.dispatchEvent(event)
}

/** Dispatch a paste whose payload appears only under `clipboardData.items` —
 * how Chromium can deliver a pasted screenshot (`files` empty). */
function pasteFilesViaItems(target: Element, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const items = files.map((file) => ({ kind: 'file', getAsFile: (): File => file }))
  Object.assign(event, { clipboardData: { items, files: [] } })
  target.dispatchEvent(event)
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

beforeEach(() => {
  mountConfirmDialog()
})

describe('roadmap pane', () => {
  it('lists items quietly — ready is silent; only exceptional statuses chip', async () => {
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
      assert.deepEqual(badges, ['blocked'], 'default ready has no status chip')
      assert.ok(list.querySelector('.roadmap-status-badge.is-blocked'), 'status styles the badge')
      assert.ok(list.querySelector('.roadmap-done-toggle'), 'mark-done affordance is in the DOM')
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

  it('roadmap_reveal selects the item and opens its editor (quick-open palette)', async () => {
    // The palette opens the pane (mode + pane state) before emitting the reveal,
    // so mount inactive and flip both — mirroring navigateToRoadmapItem's order.
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const { api } = makeApi([
      makeItem('a', 'Refactor the settings dialog', 'ready'),
      makeItem('b', 'Port e2e specs', 'blocked', 'waiting on PR #400'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      store.setState({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
      store.emit('files_pane_changed')
      store.emit('right_panel_mode_changed')
      store.emit('roadmap_reveal', 'b')
      await flush()
      const selected = list.querySelector('.roadmap-row.is-selected .roadmap-row-title')
      assert.equal(selected?.textContent, 'Port e2e specs')
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      assert.equal(prompt?.value, 'Port e2e specs')
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-form')?.hidden, false)
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
      assert.equal(viewer.querySelector('.memories-meta')?.textContent, 'Updated 2026-07-13')
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
      // Done items are filtered from the list until the show-done toggle is on.
      assert.equal(list.querySelector('.roadmap-row'), null)
      list.querySelector<HTMLButtonElement>('.roadmap-show-done-btn')?.click()
      assert.ok(list.querySelector('.roadmap-row.is-done'), 'done is a row class, not a chip')
      assert.equal(list.querySelectorAll('.roadmap-status-badge').length, 0)
    } finally {
      unmount()
    }
  })

  it('marks an item done from the list row without selecting it', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Ship the thing', 'ready')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const toggle = list.querySelector<HTMLElement>('.roadmap-done-toggle')
      assert.ok(toggle)
      assert.equal(toggle.title, 'Mark done')
      assert.equal(toggle.tabIndex, 0, 'the non-nested row action must be keyboard focusable')
      toggle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flush()
      assert.deepEqual(calls.setStatus, [{ id: 'a', status: 'done' }])
      assert.equal(calls.update.length, 0, 'status-only IPC, not a full update')
      // The toggle click must not select the row into the editor.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-empty')?.hidden, false)
      // Done items leave the list by default.
      assert.equal(list.querySelector('.roadmap-row'), null)
      assert.match(list.querySelector('.roadmap-list-empty')?.textContent ?? '', /Turn on "done"/i)
      list.querySelector<HTMLButtonElement>('.roadmap-show-done-btn')?.click()
      assert.equal(
        list.querySelector<HTMLElement>('.roadmap-done-toggle')?.title,
        'Reopen (set ready)',
      )
    } finally {
      unmount()
    }
  })

  it('hides done items until the show-done toggle is pressed', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([
      makeItem('a', 'Open work', 'ready'),
      makeItem('b', 'Shipped already', 'done'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const showDone = list.querySelector<HTMLButtonElement>('.roadmap-show-done-btn')
      assert.ok(showDone)
      assert.equal(showDone.getAttribute('aria-pressed'), 'false')
      let titles = [...list.querySelectorAll('.roadmap-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['Open work'])
      showDone.click()
      assert.equal(showDone.getAttribute('aria-pressed'), 'true')
      titles = [...list.querySelectorAll('.roadmap-row-title')].map((e) => e.textContent)
      assert.deepEqual(titles, ['Open work', 'Shipped already'])
    } finally {
      unmount()
    }
  })

  it('reopens a done item from the list row', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Shipped already', 'done')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-show-done-btn')?.click()
      list.querySelector<HTMLElement>('.roadmap-done-toggle')?.click()
      await flush()
      assert.deepEqual(calls.setStatus, [{ id: 'a', status: 'ready' }])
      assert.equal(list.querySelector('.roadmap-row.is-done'), null)
      assert.equal(list.querySelectorAll('.roadmap-status-badge').length, 0)
    } finally {
      unmount()
    }
  })

  it('offers no row toggle for archived items', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Old idea', 'archived')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(list.querySelector('.roadmap-done-toggle'), null)
      assert.ok(list.querySelector('.roadmap-row.is-archived'))
      assert.equal(
        list.querySelector('.roadmap-status-badge')?.textContent,
        'archived',
        'archived is an exceptional status chip',
      )
    } finally {
      unmount()
    }
  })

  it('syncs the open editor status select when its item is marked done', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Ship the thing', 'ready')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      list.querySelector<HTMLElement>('.roadmap-done-toggle')?.click()
      await flush()
      assert.equal(
        viewer.querySelector<HTMLSelectElement>('.roadmap-status-select')?.value,
        'done',
        'a later Save must not quietly revert the flip',
      )
      // Saving now keeps the flipped status.
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.equal(calls.update[0]?.status, 'done')
    } finally {
      unmount()
    }
  })

  it('deletes the selected item after confirmation', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Doomed')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      viewer.querySelector<HTMLButtonElement>('.roadmap-delete-btn')?.click()
      await flush()
      clickActiveConfirmDialogConfirm()
      await flush()
      assert.deepEqual(calls.delete, ['a'])
      assert.equal(list.querySelectorAll('.roadmap-row').length, 0)
      // With nothing selected, the editor falls back to its empty state.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-empty')?.hidden, false)
    } finally {
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

  it('picks up a background complexity stamp when onChanged fires', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, items, fireChanged } = makeApi([makeItem('a', 'Ship the thing')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      // Saved without a stamp: no badge yet.
      assert.equal(list.querySelectorAll('.roadmap-complexity-badge').length, 0)
      // The background classifier stamps the note, then main pushes the event.
      const item = items[0]
      assert.ok(item)
      item.fields['complexity'] = 'low'
      fireChanged()
      await flush()
      assert.equal(list.querySelector('.roadmap-complexity-badge')?.textContent, 'low')
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

  it('records the started thread on the item and then offers Reopen', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Ship the thing')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const reopenBtn = viewer.querySelector<HTMLButtonElement>('.roadmap-reopen-btn')
      assert.ok(reopenBtn)
      assert.equal(reopenBtn.hidden, true, 'nothing to reopen before a thread starts')
      viewer.querySelector<HTMLButtonElement>('.roadmap-start-btn')?.click()
      await flush()
      const threadId = store.getState().activeThreadId
      assert.ok(threadId)
      assert.deepEqual(calls.setThread, [{ id: 'a', threadId }], 'stamps the new thread id')
      assert.equal(reopenBtn.hidden, false, 'the tracked thread can now be reopened')
      assert.ok(list.querySelector('.roadmap-thread-chip'), 'the row shows a thread chip')
    } finally {
      unmount()
    }
  })

  it('reopens the tracked thread instead of creating a new one', async () => {
    const tracked = makeThread('t1', 'Ship the thing')
    const other = makeThread('t2', 'Something else')
    // A blank idle thread is pruned on switch-away; a draft keeps it alive so
    // the thread count stays comparable.
    other.draftPrompt = 'wip draft'
    const store = createStore({
      filesPaneOpen: true,
      rightPanelMode: 'roadmap',
      threads: [tracked, other],
      activeThreadId: 't2',
    })
    const seeded = makeItem('a', 'Ship the thing')
    seeded.fields['thread'] = 't1'
    const { api } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const reopenBtn = viewer.querySelector<HTMLButtonElement>('.roadmap-reopen-btn')
      assert.ok(reopenBtn)
      assert.equal(reopenBtn.hidden, false)
      let opened = 0
      store.on('new_thread_opened', () => opened++)
      reopenBtn.click()
      assert.equal(store.getState().activeThreadId, 't1', 'switches to the tracked thread')
      assert.equal(opened, 0, 'does not open a new thread')
      assert.equal(store.getState().threads.length, 2, 'no thread was created')
    } finally {
      unmount()
    }
  })

  it('hides Reopen and the row chip when the tracked thread no longer exists', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const seeded = makeItem('a', 'Ship the thing')
    seeded.fields['thread'] = 'deleted-thread'
    const { api } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      assert.equal(list.querySelector('.roadmap-thread-chip'), null)
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      assert.equal(viewer.querySelector<HTMLButtonElement>('.roadmap-reopen-btn')?.hidden, true)
    } finally {
      unmount()
    }
  })

  it('reopens the tracked thread from the row chip without selecting the item', async () => {
    const tracked = makeThread('t1', 'Ship the thing')
    const store = createStore({
      filesPaneOpen: true,
      rightPanelMode: 'roadmap',
      threads: [tracked, makeThread('t2', 'Current')],
      activeThreadId: 't2',
    })
    const seeded = makeItem('a', 'Ship the thing')
    seeded.fields['thread'] = 't1'
    const { api } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const chip = list.querySelector<HTMLElement>('.roadmap-thread-chip')
      assert.ok(chip)
      assert.equal(chip.tabIndex, 0, 'the nested row link must be keyboard focusable')
      chip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      assert.equal(store.getState().activeThreadId, 't1')
      // Activating the chip must not select the row into the editor.
      assert.equal(viewer.querySelector<HTMLElement>('.roadmap-empty')?.hidden, false)
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

  it('renders a persisted fit verdict when an item is reopened', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const seeded = makeItem('a', 'Fix the flash', 'ready', undefined, '#41')
    seeded.fields['fit'] = 'likely'
    seeded.fields['fitDetail'] = 'covers the repro and the fix location'
    const { api } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      // Verdict badge in the list without any check having run this session.
      assert.equal(list.querySelector('.roadmap-fit-badge')?.textContent, 'fit: likely')
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const result = viewer.querySelector<HTMLElement>('.roadmap-fit-result')
      assert.ok(result)
      assert.equal(result.hidden, false)
      assert.equal(result.textContent, 'fit: likely — covers the repro and the fix location')
    } finally {
      unmount()
    }
  })

  it('offers Check fit only for pinned items and displays the verdict', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([
      makeItem('a', 'Fix the flash', 'ready', undefined, '#41'),
      makeItem('b', 'Unpinned item'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const rows = [...list.querySelectorAll<HTMLButtonElement>('.roadmap-row')]
      // Unpinned item: no fit button offered.
      rows[1]?.click()
      assert.equal(viewer.querySelector<HTMLButtonElement>('.roadmap-fit-btn')?.hidden, true)
      // Pinned item: check runs and shows verdict + reasoning.
      rows[0]?.click()
      const fitBtn = viewer.querySelector<HTMLButtonElement>('.roadmap-fit-btn')
      assert.ok(fitBtn)
      assert.equal(fitBtn.hidden, false)
      fitBtn.click()
      await flush()
      assert.deepEqual(calls.checkFit, ['a'])
      const result = viewer.querySelector<HTMLElement>('.roadmap-fit-result')
      assert.ok(result)
      assert.equal(result.hidden, false)
      assert.match(result.textContent, /partial/)
      assert.match(result.textContent, /startup flash/)
      // The stamped verdict shows as a badge after the follow-up refresh.
      assert.equal(list.querySelector('.roadmap-fit-badge')?.textContent, 'fit: partial')
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

  it('imports issue-by-issue so items land as each prompt drafts', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi(
      [],
      [makeOpenIssue(11, 'First'), makeOpenIssue(12, 'Second', 'B body')],
    )
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-import-btn')?.click()
      await flush()
      for (const check of viewer.querySelectorAll<HTMLInputElement>('.roadmap-import-check')) {
        check.click()
      }
      viewer.querySelector<HTMLButtonElement>('.roadmap-import-confirm')?.click()
      await flush()
      // One call per issue, in selection order — not a single batch.
      assert.deepEqual(calls.importIssues, [
        [{ number: 11, title: 'First', body: '' }],
        [{ number: 12, title: 'Second', body: 'B body' }],
      ])
      assert.equal(list.querySelectorAll('.roadmap-row').length, 2)
    } finally {
      unmount()
    }
  })

  it('names the queried repo when it has no open issues', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([], [])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-import-btn')?.click()
      await flush()
      assert.equal(
        viewer.querySelector('.roadmap-import-status')?.textContent,
        'No open issues found in octo/demo.',
      )
    } finally {
      unmount()
    }
  })

  it('surfaces a not-connected error in the picker, stripped of IPC noise', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([])
    ;(api.roadmap as { openIssues: () => Promise<unknown> }).openIssues = (): Promise<unknown> =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'roadmap:openIssues': Error: GitHub CLI (gh) is not installed or not on PATH.",
        ),
      )
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-import-btn')?.click()
      await flush()
      assert.equal(
        viewer.querySelector('.roadmap-import-status')?.textContent,
        'GitHub CLI (gh) is not installed or not on PATH.',
      )
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

  it('attaches pasted files as chips and sends them on create', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      assert.ok(prompt)
      // Paste lands on the focused textarea and bubbles to the form handler.
      pasteFiles(prompt, [
        new File(['{"q":1}\n'], 'evals.jsonl', { type: 'application/x-jsonlines' }),
        new File(['png-bytes'], 'shot.png', { type: 'image/png' }),
      ])
      await waitFor(
        () => viewer.querySelectorAll('.roadmap-attachment-chip').length === 2,
        'expected both pasted files to render as chips',
      )
      const names = [...viewer.querySelectorAll('.roadmap-attachment-name')].map(
        (e) => e.textContent,
      )
      assert.deepEqual(names, ['evals.jsonl', 'shot.png'])
      // The image chip previews from the in-memory payload before any save.
      const thumb = viewer.querySelector<HTMLImageElement>('.roadmap-attachment-thumb')
      assert.ok(thumb)
      assert.equal(thumb.src, `data:image/png;base64,${btoa('png-bytes')}`)

      prompt.value = 'Run the paste evals'
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.create, [
        {
          prompt: 'Run the paste evals',
          notes: undefined,
          issue: undefined,
          attachments: [
            {
              name: 'evals.jsonl',
              mimeType: 'application/x-jsonlines',
              dataUrl: `data:application/x-jsonlines;base64,${btoa('{"q":1}\n')}`,
            },
            {
              name: 'shot.png',
              mimeType: 'image/png',
              dataUrl: `data:image/png;base64,${btoa('png-bytes')}`,
            },
          ],
        },
      ])
      // The saved item's chips render from the store, and the list shows a count.
      await waitFor(
        () => list.querySelector('.roadmap-attachment-badge') !== null,
        'expected an attachment-count badge on the list row',
      )
      const badge = list.querySelector('.roadmap-attachment-badge')
      assert.ok(badge)
      assert.equal(badge.textContent, '2')
      // Iconography is the shared paperclip SVG, not an emoji glyph.
      assert.equal(badge.querySelector('svg')?.getAttribute('data-icon'), 'file')
    } finally {
      unmount()
    }
  })

  it('claims a pasted image surfaced only via clipboardData.items', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      const form = viewer.querySelector('.roadmap-form')
      assert.ok(form)
      // Chromium sometimes exposes a pasted screenshot only under `items` —
      // the handler must still claim it (else the chat composer's document-
      // level listener grabs it for the wrong surface).
      pasteFilesViaItems(form, [new File(['png-bytes'], 'shot.png', { type: 'image/png' })])
      await waitFor(
        () => viewer.querySelectorAll('.roadmap-attachment-chip').length === 1,
        'expected the items-only paste to render as a chip',
      )
      assert.equal(viewer.querySelector('.roadmap-attachment-name')?.textContent, 'shot.png')
    } finally {
      unmount()
    }
  })

  it('removing a chip before saving drops the pending attachment', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-new-btn')?.click()
      const form = viewer.querySelector('.roadmap-form')
      assert.ok(form)
      pasteFiles(form, [new File(['x'], 'oops.txt', { type: 'text/plain' })])
      await waitFor(
        () => viewer.querySelectorAll('.roadmap-attachment-chip').length === 1,
        'expected the pasted file to render as a chip',
      )
      viewer.querySelector<HTMLButtonElement>('.roadmap-attachment-remove')?.click()
      assert.equal(viewer.querySelectorAll('.roadmap-attachment-chip').length, 0)
      const prompt = viewer.querySelector<HTMLTextAreaElement>('.roadmap-prompt-input')
      assert.ok(prompt)
      prompt.value = 'No attachments after all'
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.create, [
        { prompt: 'No attachments after all', notes: undefined, issue: undefined },
      ])
    } finally {
      unmount()
    }
  })

  it('removing a stored attachment sends removeAttachmentIds on save', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const seeded = makeItem('a', 'Prompt with files')
    seeded.fields['attachments'] = JSON.stringify([
      { id: 'att-1', name: 'shot.png', mimeType: 'image/png', size: 3 },
      { id: 'att-2', name: 'evals.jsonl', mimeType: 'application/x-jsonlines', size: 8 },
    ])
    const { api, calls } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      const chips = viewer.querySelectorAll('.roadmap-attachment-chip')
      assert.equal(chips.length, 2, 'stored attachments render as chips')
      // The image thumbnail hydrates lazily over IPC.
      await waitFor(
        () => calls.attachmentData.includes('a/att-1'),
        'expected the image thumbnail to fetch its payload',
      )
      viewer.querySelector<HTMLButtonElement>('[aria-label="Remove attachment shot.png"]')?.click()
      assert.equal(viewer.querySelectorAll('.roadmap-attachment-chip').length, 1)
      viewer.querySelector('.roadmap-form')?.dispatchEvent(new Event('submit'))
      await flush()
      assert.deepEqual(calls.update, [
        {
          id: 'a',
          prompt: 'Prompt with files',
          notes: undefined,
          status: 'ready',
          issue: undefined,
          removeAttachmentIds: ['att-1'],
        },
      ])
    } finally {
      unmount()
    }
  })

  it('carries attachments into the composer when starting a thread', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const seeded = makeItem('a', 'Run the evals', 'ready')
    seeded.fields['attachments'] = JSON.stringify([
      { id: 'att-img', name: 'shot.png', mimeType: 'image/png', size: 3 },
    ])
    const { api } = makeApi([seeded])
    const { list, viewer } = mountHosts()
    const attachedImages: { dataUrl: string; mimeType: string }[] = []
    const attachedFiles: { path: string; content: string }[] = []
    const unregister = registerPromptAttachments({
      attachFile: (f) => attachedFiles.push(f),
      attachTextBlock: () => {},
      attachImage: (dataUrl, mimeType) => attachedImages.push({ dataUrl, mimeType }),
      attachVideo: () => Promise.resolve(),
    })
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      // Add an unsaved .jsonl on top of the stored image; both must travel.
      const form = viewer.querySelector('.roadmap-form')
      assert.ok(form)
      pasteFiles(form, [
        new File(['{"q":1}\n'], 'evals.jsonl', { type: 'application/x-jsonlines' }),
      ])
      await waitFor(
        () => viewer.querySelectorAll('.roadmap-attachment-chip').length === 2,
        'expected the pasted file chip beside the stored one',
      )
      viewer.querySelector<HTMLButtonElement>('.roadmap-start-btn')?.click()
      await waitFor(
        () => attachedImages.length === 1 && attachedFiles.length === 1,
        'expected both attachments to reach the composer',
      )
      assert.deepEqual(attachedImages, [
        { dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' },
      ])
      assert.deepEqual(attachedFiles, [{ path: 'evals.jsonl', content: '{"q":1}\n' }])
      const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
      assert.equal(thread?.draftPrompt, 'Run the evals')
    } finally {
      unregister()
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

  it('runs review across active items and advances checkpoint only on close', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([makeItem('a', 'Fix startup flash', 'ready', undefined, '#41')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-review-btn')?.click()
      await flush()
      assert.equal(calls.prepareReview, 1)
      assert.equal(calls.reviewItem.length, 1)
      assert.equal(calls.reviewItem[0]?.runId, 'bulk-run-1')
      assert.equal(calls.completeReview.length, 0)
      assert.match(viewer.querySelector('.roadmap-review-status')?.textContent ?? '', /complete/i)
      viewer.querySelector<HTMLButtonElement>('.roadmap-review-close')?.click()
      await flush()
      assert.deepEqual(calls.completeReview, ['bulk-run-1'])
      assert.ok(list.querySelector('.roadmap-review-badge.is-likely'))
      assert.ok(viewer.querySelector('.roadmap-review-row-detail ul'))
    } finally {
      unmount()
    }
  })

  it('auto deep-checks a stale item on open', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const stale = makeItem('a', 'Fix startup flash', 'ready', undefined, '#41')
    stale.fields = {
      ...stale.fields,
      reviewVerdict: 'likely',
      reviewBulkRun: 'old-run',
    }
    const { api, calls } = makeApi([stale])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      await flush()
      assert.deepEqual(calls.reviewItemDeep, ['a'])
      assert.match(
        viewer.querySelector('.roadmap-review-result-meta')?.textContent ?? '',
        /resolved/i,
      )
    } finally {
      unmount()
    }
  })

  it('clears the deep-check spinner when switching items mid-flight', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const itemA = makeItem('a', 'Fix A', 'ready', undefined, '#41')
    itemA.fields = {
      ...itemA.fields,
      reviewVerdict: 'open',
      reviewDetail: 'Still open',
      reviewBulkRun: 'bulk-run-1',
    }
    const itemB = makeItem('b', 'Fix B', 'ready', undefined, '#42')
    itemB.fields = {
      ...itemB.fields,
      reviewVerdict: 'likely',
      reviewDetail: 'Probably done',
      reviewBulkRun: 'bulk-run-1',
    }
    let releaseDeep: (() => void) | undefined
    const deepGate = new Promise<void>((resolve) => {
      releaseDeep = resolve
    })
    const { api, calls } = makeApi([itemA, itemB])
    api.roadmap.reviewItemDeep = async (
      id: string,
    ): Promise<{
      id: string
      verdict: 'resolved'
      detail: string
      depth: 'deep'
      pinnedIssue: null
      linkedIssues: []
    }> => {
      calls.reviewItemDeep.push(id)
      await deepGate
      return {
        id,
        verdict: 'resolved' as const,
        detail: 'Deep check · Issue closed',
        depth: 'deep' as const,
        pinnedIssue: null,
        linkedIssues: [],
      }
    }
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      const rows = list.querySelectorAll<HTMLButtonElement>('.roadmap-row')
      rows[0]?.click()
      await flush()
      viewer.querySelector<HTMLButtonElement>('.roadmap-resolution-btn')?.click()
      await flush()
      assert.match(
        viewer.querySelector('.roadmap-review-result-meta')?.textContent ?? '',
        /Deep resolution check/i,
      )
      rows[1]?.click()
      await flush()
      const meta = viewer.querySelector('.roadmap-review-result-meta')?.textContent ?? ''
      assert.doesNotMatch(meta, /Deep resolution check/i)
      assert.match(meta, /review: likely/i)
      releaseDeep?.()
      await flush()
    } finally {
      unmount()
    }
  })

  it('shows the review panel when review starts with an item already open', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Fix startup flash', 'ready', undefined, '#41')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-row')?.click()
      await flush()
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-form:not([hidden])'))
      list.querySelector<HTMLButtonElement>('.roadmap-review-btn')?.click()
      await flush()
      const reviewView = viewer.querySelector<HTMLElement>('.roadmap-review')
      assert.ok(reviewView)
      assert.equal(reviewView.hidden, false)
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-form[hidden]'))
    } finally {
      unmount()
    }
  })

  it('marks a likely review row done from triage actions', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls, items } = makeApi([
      makeItem('a', 'Fix startup flash', 'ready', 'notes', '#41'),
    ])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-review-btn')?.click()
      await flush()
      const first = items[0]
      assert.ok(first)
      first.body = 'Prompt edited in another pane'
      viewer.querySelector<HTMLButtonElement>('.roadmap-review-mark-done')?.click()
      await flush()
      assert.deepEqual(calls.setStatus, [{ id: 'a', status: 'done' }])
      assert.equal(calls.update.length, 0, 'status triage must not replay stale prompt fields')
      assert.equal(items[0]?.body, 'Prompt edited in another pane')
      assert.ok(viewer.querySelector('.roadmap-review-applied-badge'))
    } finally {
      unmount()
    }
  })

  it('returns to the review panel after opening an item from triage', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api } = makeApi([makeItem('a', 'Fix startup flash', 'ready', undefined, '#41')])
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-review-btn')?.click()
      await flush()
      const reviewView = viewer.querySelector<HTMLElement>('.roadmap-review')
      assert.ok(reviewView)
      assert.equal(reviewView.hidden, false)

      viewer.querySelector<HTMLButtonElement>('.roadmap-review-open')?.click()
      await flush()
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-form:not([hidden])'))
      assert.equal(reviewView.hidden, true)
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-review-back:not([hidden])'))

      viewer.querySelector<HTMLButtonElement>('.roadmap-review-back')?.click()
      await flush()
      assert.equal(reviewView.hidden, false)
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-form[hidden]'))
      assert.ok(viewer.querySelector('.roadmap-review-row'))
    } finally {
      unmount()
    }
  })

  it('stops an in-progress review and keeps partial triage results', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'roadmap' })
    const { api, calls } = makeApi([
      makeItem('a', 'Fix startup flash', 'ready', undefined, '#41'),
      makeItem('b', 'Terminal shortcut', 'ready', undefined, '#42'),
    ])
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const reviewProgress = { secondStarted: false }
    const baseReviewItem = api.roadmap.reviewItem
    api.roadmap.reviewItem = async (
      id: string,
      commits: string,
      runId?: string,
    ): Promise<Awaited<ReturnType<typeof baseReviewItem>>> => {
      if (id === 'b') {
        reviewProgress.secondStarted = true
        await secondGate
      }
      return baseReviewItem(id, commits, runId)
    }
    const { list, viewer } = mountHosts()
    const unmount = mountRoadmapPane(list, viewer, store, api)
    try {
      await flush()
      list.querySelector<HTMLButtonElement>('.roadmap-review-btn')?.click()
      for (let i = 0; i < 20 && !reviewProgress.secondStarted; i++) await flush()
      assert.ok(reviewProgress.secondStarted, 'second item review should have started')

      viewer.querySelector<HTMLButtonElement>('.roadmap-review-stop')?.click()
      await flush()
      releaseSecond()
      await flush()

      assert.equal(viewer.querySelectorAll('.roadmap-review-row').length, 1)
      assert.deepEqual(calls.abortReview, ['bulk-run-1'])
      assert.equal(calls.completeReview.length, 0)
      assert.match(viewer.querySelector('.roadmap-review-status')?.textContent ?? '', /stopped/i)
      assert.ok(viewer.querySelector<HTMLElement>('.roadmap-review-stop[hidden]'))

      viewer.querySelector<HTMLButtonElement>('.roadmap-review-close')?.click()
      await flush()
      assert.equal(calls.completeReview.length, 0)
    } finally {
      unmount()
    }
  })
})
