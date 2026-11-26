import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStageResult, GitStatusResult } from '@shared/types/git.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The stage bar under the Changes pane diff moves the selected file between
// Unstaged and Staged. Line staging needs Monaco, which this tier does not
// mount; tests/e2e/git-changes-staging.e2e.ts covers it.

interface Fake {
  api: ApiClient
  calls: string[]
  setStatus(next: GitStatusResult): void
  release(result: GitStageResult): void
}

function fakeApi(initial: GitStatusResult): Fake {
  const base = createFakeApi()
  const calls: string[] = []
  let status = initial
  let release: (result: GitStageResult) => void = () => {}
  const api = {
    ...base,
    git: {
      ...base['git'],
      isAvailable: (): Promise<boolean> => Promise.resolve(true),
      status: (): Promise<GitStatusResult> => Promise.resolve(status),
      fileDiff: (): Promise<null> => Promise.resolve(null),
      committedChanges: (): Promise<null> => Promise.resolve(null),
      sessionBackup: (): Promise<null> => Promise.resolve(null),
      setPathStaged: (
        _projectId: string,
        _threadId: string,
        path: string,
        staged: boolean,
      ): Promise<GitStageResult> => {
        calls.push(`${path}:${String(staged)}`)
        return new Promise((resolve) => {
          release = resolve
        })
      },
    },
  } satisfies ApiClient
  return {
    api,
    calls,
    setStatus: (next): void => {
      status = next
    },
    release: (result): void => {
      release(result)
    },
  }
}

function mount(api: ApiClient): { list: HTMLElement; viewer: HTMLElement } {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  mountGitChangesPane(list, viewer, store, api, null)
  return { list, viewer }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function selectedRow(list: HTMLElement): string | null | undefined {
  const row = list.querySelector('.git-change-row.is-selected')
  const section = row?.closest('.git-changes-section')?.querySelector('.git-changes-section-title')
  return row
    ? `${section?.textContent ?? ''} ${row.querySelector('.git-change-path')?.textContent ?? ''}`
    : null
}

describe('git changes pane staging', () => {
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

  it('stages the selected file once and follows it to Staged', async () => {
    const fake = fakeApi({ staged: [], unstaged: [{ path: 'src/a.ts', status: 'modified' }] })
    const { list, viewer } = mount(fake.api)
    await settle()
    const bar = viewer.querySelector<HTMLElement>('.git-stage-bar')
    const file = viewer.querySelector<HTMLButtonElement>('.git-stage-file-btn')
    const status = viewer.querySelector<HTMLElement>('.git-stage-status')
    assert.ok(bar && file && status)
    assert.equal(bar.hidden, false)
    assert.equal(file.textContent, 'Stage file')

    file.click()
    file.click()
    assert.deepEqual(fake.calls, ['src/a.ts:true'])
    assert.equal(file.disabled, true)
    assert.equal(status.textContent, 'Staging…')

    fake.setStatus({ staged: [{ path: 'src/a.ts', status: 'modified' }], unstaged: [] })
    fake.release({ ok: true, message: 'Staged src/a.ts.' })
    await settle()
    assert.equal(selectedRow(list), 'Staged (1) src/a.ts')
    assert.equal(file.textContent, 'Unstage file')
    assert.equal(file.disabled, false)
    assert.equal(status.textContent, 'Staged src/a.ts.')
  })

  it('shows a refusal beside the diff and keeps the file where it was', async () => {
    const fake = fakeApi({ staged: [{ path: 'b.ts', status: 'modified' }], unstaged: [] })
    const { list, viewer } = mount(fake.api)
    await settle()
    viewer.querySelector<HTMLButtonElement>('.git-stage-file-btn')?.click()
    assert.deepEqual(fake.calls, ['b.ts:false'])
    fake.release({ ok: false, message: 'index.lock exists' })
    await settle()
    const status = viewer.querySelector('.git-stage-status')
    assert.ok(status)
    assert.equal(status.textContent, 'index.lock exists')
    assert.equal(status.getAttribute('data-ok'), 'false')
    assert.equal(selectedRow(list), 'Staged (1) b.ts')
  })

  it('stages untracked files whole and has no bar without a working-tree row', async () => {
    const fake = fakeApi({ staged: [], unstaged: [{ path: 'new.ts', status: 'untracked' }] })
    const { viewer } = mount(fake.api)
    await settle()
    const lines = viewer.querySelector<HTMLButtonElement>('.git-stage-lines-btn')
    assert.ok(lines)
    assert.equal(lines.disabled, true)
    assert.match(lines.getAttribute('data-tooltip') ?? '', /staged whole/)
    assert.equal(viewer.querySelector<HTMLButtonElement>('.git-stage-file-btn')?.disabled, false)

    document.body.replaceChildren()
    const clean = mount(fakeApi({ staged: [], unstaged: [] }).api)
    await settle()
    assert.equal(clean.viewer.querySelector<HTMLElement>('.git-stage-bar')?.hidden, true)
  })
})
