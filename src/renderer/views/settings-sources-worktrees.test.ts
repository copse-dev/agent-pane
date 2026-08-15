// Sources → Worktrees: what each linked checkout is for, what it costs, and the
// two-step confirmation that stands between the Delete button and the disk.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Project } from '@shared/types/state.ts'
import type {
  WorktreeInventoryEntry,
  WorktreePackageCleanupResult,
  WorktreeRemovalResult,
  WorktreeSizeResult,
} from '@shared/types/worktree.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from './confirm-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

const HOUR = 60 * 60 * 1000

interface RemoveCall {
  projectId: string
  path: string
  force: boolean
}

interface CleanupCall {
  projectId: string
  path: string
  remove: boolean
}

const USAGE = {
  threadId: 'thread-1',
  title: 'Fix the flicker',
  updatedAt: Date.now() - 3 * HOUR,
  archived: false,
  linked: true,
  running: false,
}

function entry(overrides: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    path: '/home/dev/.copse/worktrees/project-1/thread-1',
    branch: 'copse/fix-the-flicker-thread-1',
    baseBranch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    locked: null,
    prunable: null,
    managed: true,
    usage: { ...USAGE },
    createdAt: Date.now() - 5 * HOUR,
    lastUsedAt: Date.now() - 3 * HOUR,
    changedCount: 0,
    merged: true,
    ...overrides,
  }
}

function stubApi(
  entries: WorktreeInventoryEntry[],
  options: {
    removals?: WorktreeRemovalResult[]
    calls?: RemoveCall[]
    projectCalls?: string[]
    size?: WorktreeSizeResult
    cleanupResults?: WorktreePackageCleanupResult[]
    cleanupCalls?: CleanupCall[]
    terminalCalls?: Array<{ projectId: string; path: string }>
  } = {},
): ApiClient {
  const base = createFakeApi()
  const removals = [...(options.removals ?? [])]
  const cleanupResults = [...(options.cleanupResults ?? [])]
  return {
    ...base,
    instructions: { ...base.instructions, list: () => Promise.resolve([]) },
    cursorRules: { ...base.cursorRules, list: () => Promise.resolve([]) },
    skills: { ...base.skills, list: () => Promise.resolve([]) },
    cursorPlugins: { ...base.cursorPlugins, list: () => Promise.resolve([]) },
    hooks: { ...base.hooks, list: () => Promise.resolve({ hooks: [], warnings: [] }) },
    worktrees: {
      list: (projectId: string): Promise<WorktreeInventoryEntry[]> => {
        options.projectCalls?.push(projectId)
        return Promise.resolve(entries)
      },
      size: (_projectId: string, path: string) =>
        Promise.resolve(
          options.size ?? { path, bytes: 12 * 1024 * 1024, fileCount: 42, truncated: false },
        ),
      cleanupPackages: (
        projectId: string,
        path: string,
        remove: boolean,
      ): Promise<WorktreePackageCleanupResult> => {
        options.cleanupCalls?.push({ projectId, path, remove })
        return Promise.resolve(
          cleanupResults.shift() ?? {
            status: 'ready',
            path,
            directories: [],
            bytes: 0,
            truncated: false,
          },
        )
      },
      openTerminal: (projectId: string, path: string): Promise<void> => {
        options.terminalCalls?.push({ projectId, path })
        return Promise.resolve()
      },
      remove: (projectId: string, path: string, force: boolean): Promise<WorktreeRemovalResult> => {
        options.calls?.push({ projectId, path, force })
        const next = removals.shift()
        return Promise.resolve(
          next ?? { status: 'removed', path, branch: null, branchDeleted: false },
        )
      },
    },
  }
}

/** Settle the list load, the per-row size calls, and any dialog round-trip. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 6; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openWorktrees(
  api: ApiClient,
  projects: Project[] = [{ id: 'project-1', name: 'Copse', path: '/home/dev/copse' }],
  activeProjectId = 'project-1',
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountConfirmDialog()
  mountSettingsDialog(createStore({ activeProjectId, projects }), api)
  const sourcesBtn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="storage"]',
  )
  assert.ok(sourcesBtn)
  sourcesBtn.click()
  await flush()
  const list = document.getElementById('sources-worktrees-list')
  assert.ok(list)
  return list
}

function deleteButton(list: HTMLElement): HTMLButtonElement {
  const button = list.querySelector<HTMLButtonElement>('.sources-worktree-delete-btn')
  assert.ok(button)
  return button
}

describe('settings sources → worktrees list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.getElementById('confirm-dialog')?.remove()
  })

  it('shows the empty state when the project owns no checkouts', async () => {
    const list = await openWorktrees(stubApi([]))
    assert.match(list.textContent, /No worktrees\./)
    assert.equal(list.querySelectorAll('.sources-row').length, 0)
  })

  it('lets the user inspect a different local project without switching workspaces', async () => {
    const projectCalls: string[] = []
    const calls: RemoveCall[] = []
    const list = await openWorktrees(stubApi([entry()], { calls, projectCalls }), [
      { id: 'project-1', name: 'Copse', path: '/home/dev/copse' },
      { id: 'project-2', name: 'Website', path: '/home/dev/website' },
    ])

    const select = document.querySelector<HTMLSelectElement>('#storage-project-select')
    assert.ok(select)
    assert.deepEqual(
      [...select.options].map((option) => [option.value, option.textContent]),
      [
        ['project-1', 'Copse — /home/dev/copse'],
        ['project-2', 'Website — /home/dev/website'],
      ],
    )
    assert.equal(select.value, 'project-1')
    select.value = 'project-2'
    select.dispatchEvent(new Event('change'))
    await flush()

    assert.deepEqual(projectCalls, ['project-1', 'project-2'])
    assert.equal(document.getElementById('storage-project-path')?.textContent, '/home/dev/website')

    deleteButton(list).click()
    await flush()
    clickActiveConfirmDialogConfirm()
    await flush()
    assert.deepEqual(calls, [{ projectId: 'project-2', path: entry().path, force: false }])
  })

  it('names the owning thread, when it was last used, and its size on disk', async () => {
    const list = await openWorktrees(stubApi([entry()]))
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    assert.equal(
      row.querySelector('.sources-row-title')?.textContent,
      'copse/fix-the-flicker-thread-1',
    )
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'thread')
    const threadButton = row.querySelector<HTMLButtonElement>('.sources-worktree-thread-btn')
    assert.ok(threadButton)
    assert.equal(threadButton.title, 'Open thread “Fix the flicker”')
    const detail = row.querySelector('.sources-row-detail')?.textContent ?? ''
    assert.match(detail, /Thread “Fix the flicker”/)
    assert.match(detail, /last used 3h ago/)
    assert.equal(row.querySelector('.sources-worktree-size')?.textContent, '12 MB')
    assert.equal(row.querySelector('.sources-row-hover-detail')?.textContent, entry().path)
  })

  it('opens the owning thread from its badge', async () => {
    const list = await openWorktrees(stubApi([entry()]))
    const threadButton = list.querySelector<HTMLButtonElement>('.sources-worktree-thread-btn')
    assert.ok(threadButton)
    threadButton.click()
    const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
    assert.equal(dialog?.open, false)
  })

  it('opens the system terminal at the registered checkout', async () => {
    const terminalCalls: Array<{ projectId: string; path: string }> = []
    const list = await openWorktrees(stubApi([entry()], { terminalCalls }))
    const button = list.querySelector<HTMLButtonElement>('.sources-worktree-terminal-btn')
    assert.ok(button)
    button.click()
    await flush()
    assert.deepEqual(terminalCalls, [{ projectId: 'project-1', path: entry().path }])
    assert.match(
      document.getElementById('sources-worktrees-status')?.textContent ?? '',
      /Opened a terminal/,
    )
  })

  it('previews package cleanup and removes it only after confirmation', async () => {
    const cleanupCalls: CleanupCall[] = []
    const result: WorktreePackageCleanupResult = {
      status: 'ready',
      path: entry().path,
      directories: [
        { path: 'node_modules', bytes: 12 * 1024 * 1024, truncated: false },
        { path: 'packages/app/.venv', bytes: 4 * 1024 * 1024, truncated: false },
      ],
      bytes: 16 * 1024 * 1024,
      truncated: false,
    }
    const cleaned: WorktreePackageCleanupResult = { ...result, status: 'cleaned' }
    const list = await openWorktrees(
      stubApi([entry()], { cleanupCalls, cleanupResults: [result, cleaned] }),
    )
    const button = list.querySelector<HTMLButtonElement>('.sources-worktree-cleanup-btn')
    assert.ok(button)
    button.click()
    await flush()

    const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog')
    assert.ok(dialog?.open)
    assert.match(dialog.querySelector('.confirm-dialog-message')?.textContent ?? '', /2 package/)
    assert.match(dialog.querySelector('.confirm-dialog-detail')?.textContent ?? '', /node_modules/)
    assert.deepEqual(cleanupCalls, [{ projectId: 'project-1', path: entry().path, remove: false }])

    clickActiveConfirmDialogConfirm()
    await flush()
    assert.deepEqual(cleanupCalls, [
      { projectId: 'project-1', path: entry().path, remove: false },
      { projectId: 'project-1', path: entry().path, remove: true },
    ])
  })

  it('badges a checkout its thread has let go of, and one with no thread at all', async () => {
    const released = entry({
      path: '/w/released',
      usage: { ...USAGE, linked: false },
    })
    const orphaned = entry({ path: '/w/orphaned', usage: null })
    const list = await openWorktrees(stubApi([released, orphaned]))
    const badges = [...list.querySelectorAll('.sources-row')].map(
      (row) => row.querySelector('.sources-badge')?.textContent,
    )
    assert.deepEqual(badges, ['released', 'orphaned'])
  })

  it('flags uncommitted work and unmerged commits, and blocks deleting a running checkout', async () => {
    const busy = entry({
      changedCount: 3,
      merged: false,
      usage: { ...USAGE, running: true },
    })
    const list = await openWorktrees(stubApi([busy]))
    const badges = [...list.querySelectorAll('.sources-badge')].map((b) => b.textContent)
    assert.deepEqual(badges, ['in use', '3 uncommitted', 'unmerged'])
    assert.equal(deleteButton(list).disabled, true)
    assert.equal(
      list.querySelector<HTMLButtonElement>('.sources-worktree-cleanup-btn')?.disabled,
      true,
    )
  })

  it('deletes a clean checkout after one confirmation', async () => {
    const calls: RemoveCall[] = []
    const list = await openWorktrees(
      stubApi([entry()], {
        calls,
        removals: [
          { status: 'removed', path: entry().path, branch: 'copse/fix', branchDeleted: true },
        ],
      }),
    )

    deleteButton(list).click()
    await flush()
    const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog')
    assert.ok(dialog?.open, 'deletion always asks first')
    assert.match(
      dialog.querySelector('.confirm-dialog-message')?.textContent ?? '',
      /Delete worktree copse\/fix-the-flicker-thread-1\?/,
    )
    clickActiveConfirmDialogConfirm()
    await flush()

    assert.deepEqual(calls, [{ projectId: 'project-1', path: entry().path, force: false }])
    assert.match(
      document.getElementById('sources-worktrees-status')?.textContent ?? '',
      /Deleted .* and its branch\./,
    )
  })

  it('asks a second time before discarding uncommitted files, and keeps them if refused', async () => {
    const calls: RemoveCall[] = []
    const list = await openWorktrees(
      stubApi([entry()], {
        calls,
        removals: [{ status: 'blocked-dirty', path: entry().path, changed: ['src/a.ts'] }],
      }),
    )

    deleteButton(list).click()
    await flush()
    clickActiveConfirmDialogConfirm()
    await flush()

    const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog')
    assert.ok(dialog?.open, 'the blocked result comes back as a second prompt')
    assert.match(
      dialog.querySelector('.confirm-dialog-message')?.textContent ?? '',
      /Discard 1 uncommitted file\?/,
    )
    assert.match(dialog.querySelector('.confirm-dialog-detail')?.textContent ?? '', /src\/a\.ts/)

    clickActiveConfirmDialogCancel()
    await flush()
    assert.deepEqual(
      calls,
      [{ projectId: 'project-1', path: entry().path, force: false }],
      'no forced delete was sent',
    )
    assert.equal(document.getElementById('sources-worktrees-status')?.textContent, 'Kept.')
    assert.equal(deleteButton(list).disabled, false, 'the row stays actionable')
  })

  it('forces the delete only after the second confirmation', async () => {
    const calls: RemoveCall[] = []
    const list = await openWorktrees(
      stubApi([entry()], {
        calls,
        removals: [
          { status: 'blocked-dirty', path: entry().path, changed: ['src/a.ts'] },
          { status: 'removed', path: entry().path, branch: 'copse/fix', branchDeleted: false },
        ],
      }),
    )

    deleteButton(list).click()
    await flush()
    clickActiveConfirmDialogConfirm()
    await flush()
    clickActiveConfirmDialogConfirm()
    await flush()

    assert.deepEqual(calls, [
      { projectId: 'project-1', path: entry().path, force: false },
      { projectId: 'project-1', path: entry().path, force: true },
    ])
  })
})
