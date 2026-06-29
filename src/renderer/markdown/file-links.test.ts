import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  annotateFileReferences,
  bindFileReferenceClicks,
  findFileReferenceCandidates,
} from './file-links.ts'

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

describe('markdown file links', () => {
  it('collects file-like references outside pre blocks and existing links', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<p>Read src/main/index.ts and renderer.ts.</p>',
      '<p><code>README.md</code></p>',
      '<pre>src/secret.ts</pre>',
      '<a href="https://example.com/package.json">package.json</a>',
    ].join('')

    assert.deepEqual(findFileReferenceCandidates(root), [
      'src/main/index.ts',
      'renderer.ts',
      'README.md',
    ])
  })

  it('annotates resolved references as workspace file links', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Read src/main/index.ts, renderer.ts, and README.md.</p>'

    await annotateFileReferences(
      root,
      apiWithFileReferences([
        { candidate: 'src/main/index.ts', path: 'src/main/index.ts' },
        { candidate: 'renderer.ts', path: 'src/renderer/markdown/renderer.ts' },
        { candidate: 'README.md', path: 'README.md' },
      ]),
    )

    const links = [...root.querySelectorAll<HTMLAnchorElement>('a.file-reference-link')]
    assert.equal(links.length, 3)
    const [link0, link1] = links
    assert.ok(link0 && link1, 'expected at least two file-reference links')
    assert.equal(link0.textContent, 'src/main/index.ts')
    assert.equal(link0.dataset['fileReferencePath'], 'src/main/index.ts')
    assert.equal(link1.textContent, 'renderer.ts')
    assert.equal(link1.dataset['fileReferencePath'], 'src/renderer/markdown/renderer.ts')
    assert.equal(root.textContent, 'Read src/main/index.ts, renderer.ts, and README.md.')
  })

  it('opens generated file links in the explorer panel', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="#" data-file-reference-path="src/main/index.ts">src/main/index.ts</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'terminal' })
    const unbind = bindFileReferenceClicks(root, store, apiWithFileReferences([], 'export {}\n'))

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    const anchor = root.querySelector('a')
    assert.ok(anchor, 'expected an anchor element')
    anchor.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    assert.equal(store.getState().openFile?.path, 'src/main/index.ts')
    assert.equal(store.getState().openFile?.content, 'export {}\n')
  })
})
