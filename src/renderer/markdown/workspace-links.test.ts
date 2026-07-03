import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { bindWorkspaceLinkClicks } from './workspace-links.ts'

function apiWithFileReferences(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[],
  fileContent = 'file contents',
): ApiClient {
  return {
    index: {
      query: async () => [],
      resolveFileReferences: async () =>
        resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) })),
    },
    fs: {
      readFile: async () => fileContent,
    },
  } as unknown as ApiClient
}

describe('markdown workspace links', () => {
  it('renders root-relative markdown links as workspace links', () => {
    const html = renderMarkdown('[Experiment Framework v2](/docs/experiments/v2.md)')
    assert.match(html, /data-workspace-link="true"/)
    assert.match(html, /href="\/docs\/experiments\/v2\.md"/)
    assert.doesNotMatch(html, /data-browser-link/)
  })

  it('opens resolved workspace markdown links in the explorer panel', async () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('[guide](/docs/experiments/v2.md)')
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    const api = apiWithFileReferences([
      { candidate: 'docs/experiments/v2.md', path: 'docs/experiments/v2.md' },
    ])
    const unbind = bindWorkspaceLinkClicks(root, store, api)

    const anchor = root.querySelector('a')
    assert.ok(anchor, 'expected workspace markdown link')
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(store.getState().openFile?.path, 'docs/experiments/v2.md')
  })
})
