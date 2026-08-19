import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitCommittedChanges, GitFileDiff, GitStatusResult } from '@shared/types/git.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// An agent that commits its work empties `git status`, which used to blank the
// Changes pane and leave the work reviewable nowhere until a PR existed. The
// pane also lists commits no pull request carries yet.

const CLEAN: GitStatusResult = { staged: [], unstaged: [] }

function makeApi(opts: {
  status?: GitStatusResult
  committed?: GitCommittedChanges | null
  committedDiffs?: { path: string }[]
}): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    git: {
      ...base['git'],
      isAvailable: async () => true,
      status: async () => opts.status ?? CLEAN,
      fileDiff: async () => null,
      committedChanges: async () => opts.committed ?? null,
      // Null keeps the pane out of Monaco, which this tier does not mount; the
      // rendered diff is covered by tests/e2e/git-changes.e2e.ts.
      committedFileDiff: async (
        _projectId: string,
        _threadId: string,
        path: string,
      ): Promise<GitFileDiff | null> => {
        opts.committedDiffs?.push({ path })
        return null
      },
      sessionBackup: async () => null,
    },
  } satisfies ApiClient
}

function mount(api: ApiClient): HTMLElement {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  mountGitChangesPane(listRoot, viewerRoot, store, api, null)
  return listRoot
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function sectionTitles(listRoot: HTMLElement): (string | null)[] {
  return [...listRoot.querySelectorAll('.git-changes-section-title')].map(
    (element) => element.textContent,
  )
}

describe('git changes pane committed section', () => {
  beforeEach(() => {
    if (!('ResizeObserver' in globalThis)) {
      class NoopResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = NoopResizeObserver
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('lists commits that no pull request carries yet', async () => {
    const listRoot = mount(
      makeApi({
        committed: {
          baseLabel: 'main',
          changes: [
            { path: 'src/added.ts', status: 'added' },
            { path: 'src/edited.ts', status: 'modified' },
          ],
        },
      }),
    )
    await settle()

    assert.deepEqual(sectionTitles(listRoot), ['Committed (2)'])
    const paths = [...listRoot.querySelectorAll('.git-change-row-committed .git-change-path')].map(
      (element) => element.textContent,
    )
    assert.deepEqual(paths, ['src/added.ts', 'src/edited.ts'])
    assert.equal(listRoot.querySelector('.git-changes-empty'), null)
  })

  it('names the base it compared against, so "not in a PR" is legible', async () => {
    const listRoot = mount(
      makeApi({
        committed: {
          baseLabel: 'origin/feature-x',
          changes: [{ path: 'src/local-only.ts', status: 'added' }],
        },
      }),
    )
    await settle()

    const title = listRoot.querySelector('.git-changes-section-title')
    assert.match(title?.getAttribute('data-tooltip') ?? '', /origin\/feature-x/)
  })

  it('keeps committed work below the working tree and selects the first uncommitted file', async () => {
    const committedDiffs: { path: string }[] = []
    const listRoot = mount(
      makeApi({
        status: { staged: [{ path: 'staged.ts', status: 'modified' }], unstaged: [] },
        committed: { baseLabel: 'main', changes: [{ path: 'committed.ts', status: 'added' }] },
        committedDiffs,
      }),
    )
    await settle()

    assert.deepEqual(sectionTitles(listRoot), ['Staged (1)', 'Committed (1)'])
    assert.equal(committedDiffs.length, 0, 'an uncommitted file outranks committed work')
    const selected = listRoot.querySelector('.git-change-row.is-selected .git-change-path')
    assert.equal(selected?.textContent, 'staged.ts')
  })

  it('opens the first committed file when nothing is uncommitted', async () => {
    const committedDiffs: { path: string }[] = []
    const listRoot = mount(
      makeApi({
        committed: {
          baseLabel: 'main',
          changes: [
            { path: 'first.ts', status: 'added' },
            { path: 'second.ts', status: 'modified' },
          ],
        },
        committedDiffs,
      }),
    )
    await settle()

    assert.deepEqual(
      committedDiffs.map((entry) => entry.path),
      ['first.ts'],
    )
    const selected = listRoot.querySelector('.git-change-row.is-selected .git-change-path')
    assert.equal(selected?.textContent, 'first.ts')
  })

  it('requests the committed diff for the clicked file', async () => {
    const committedDiffs: { path: string }[] = []
    const listRoot = mount(
      makeApi({
        status: { staged: [{ path: 'staged.ts', status: 'modified' }], unstaged: [] },
        committed: {
          baseLabel: 'main',
          changes: [{ path: 'committed.ts', status: 'added' }],
        },
        committedDiffs,
      }),
    )
    await settle()

    listRoot.querySelector<HTMLButtonElement>('.git-change-row-committed')?.click()
    await settle()

    assert.deepEqual(
      committedDiffs.map((entry) => entry.path),
      ['committed.ts'],
    )
    const selected = listRoot.querySelector('.git-change-row.is-selected .git-change-path')
    assert.equal(selected?.textContent, 'committed.ts')
  })

  it('still reports an empty pane when nothing is committed or changed', async () => {
    const listRoot = mount(makeApi({ committed: { baseLabel: 'main', changes: [] } }))
    await settle()

    assert.equal(listRoot.querySelector('.git-changes-empty')?.textContent, 'No changes')
  })
})
