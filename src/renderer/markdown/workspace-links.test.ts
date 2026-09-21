import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { bindWorkspaceLinkClicks } from './workspace-links.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function apiWithFileReferences(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[],
  fileContent = 'file contents',
): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      index: {
        ...base['index'],
        query: async () => [],
        resolveFileReferences: async () =>
          resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) })),
      },
      fs: {
        ...base['fs'],
        readFile: async () => fileContent,
      },
    } satisfies ApiClient
  })()
}

describe('markdown workspace links', () => {
  it('does not show a stale lookup error after leaving its task', async () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('[Private chart](/private-chart.png)')
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let reject: (error: Error) => void = () => undefined
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail
    })
    const api = {
      ...base,
      index: { ...base.index, resolveFileReferences: (): Promise<never> => pending },
    }
    const unbind = bindWorkspaceLinkClicks(root, store, api)
    root
      .querySelector('a')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    store.setState({ activeThreadId: 'thread-2' })
    reject(new Error('private old task lookup failed'))
    await new Promise((done) => setTimeout(done, 0))
    unbind()
    assert.doesNotMatch(
      document.body.textContent,
      /private old task lookup failed|Failed to open private-chart/,
    )
  })

  it('does not open a resolved link in a different task after navigation', async () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('[Chart](/chart.png)')
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    let resolve: (files: { candidate: string; path: string; kind: 'file' }[]) => void = () =>
      undefined
    const resolved = new Promise<{ candidate: string; path: string; kind: 'file' }[]>((done) => {
      resolve = done
    })
    let reads = 0
    const api = {
      ...base,
      index: { ...base.index, resolveFileReferences: (): typeof resolved => resolved },
      fs: {
        ...base.fs,
        readImage: async (): Promise<string> => {
          reads += 1
          return ''
        },
      },
    }
    const unbind = bindWorkspaceLinkClicks(root, store, api)
    root
      .querySelector('a')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    store.setState({ activeThreadId: 'thread-2' })
    resolve([{ candidate: '/chart.png', path: 'chart.png', kind: 'file' }])
    await new Promise((done) => setTimeout(done, 0))
    unbind()
    assert.equal(reads, 0)
    assert.equal(store.getState().openFile, null)
  })

  it('renders root-relative markdown links as workspace links', () => {
    const html = renderMarkdown('[Experiment Framework v2](/docs/experiments/v2.md)')
    assert.match(html, /data-workspace-link="true"/)
    assert.match(html, /href="\/docs\/experiments\/v2\.md"/)
    assert.doesNotMatch(html, /data-browser-link/)
  })

  it('opens resolved workspace markdown links in the explorer panel', async () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('[guide](/docs/experiments/v2.md)')
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
    const baseApi = apiWithFileReferences([
      { candidate: '/docs/experiments/v2.md', path: 'docs/experiments/v2.md' },
    ])
    let resolvedOwner: { projectId: string; threadId: string } | undefined
    let resolvedCandidates: string[] = []
    const api = {
      ...baseApi,
      index: {
        ...baseApi.index,
        resolveFileReferences: async (
          candidates: string[],
          owner?: { projectId: string; threadId: string },
        ): Promise<{ candidate: string; path: string; kind: 'file' | 'directory' }[]> => {
          resolvedOwner = owner
          resolvedCandidates = candidates
          return baseApi.index.resolveFileReferences(candidates, owner)
        },
      },
    } satisfies ApiClient
    const unbind = bindWorkspaceLinkClicks(root, store, api)

    const anchor = root.querySelector('a')
    assert.ok(anchor, 'expected workspace markdown link')
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(resolvedCandidates, ['/docs/experiments/v2.md'])
    assert.deepEqual(resolvedOwner, { projectId: 'project-1', threadId: 'thread-1' })
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(store.getState().openFile?.path, 'docs/experiments/v2.md')
  })
})
