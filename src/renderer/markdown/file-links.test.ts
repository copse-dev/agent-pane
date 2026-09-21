import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  annotateFileReferences,
  bindFileReferenceClicks,
  findFileReferenceCandidates,
} from './file-links.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'

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

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

describe('markdown file links', () => {
  before(() => {
    patchPreviewDialog()
  })

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

  it('collects file-like references inside .tool-result pre elements', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<p>Normal text renderer.ts</p>',
      '<pre>skipped/outside.ts</pre>',
      '<div class="tool-result"><pre>src/main/index.ts\nREADME.md</pre></div>',
    ].join('')

    // skipped/outside.ts is inside a bare <pre> (not .tool-result) and must be excluded;
    // src/main/index.ts and README.md inside .tool-result <pre> must be included.
    assert.deepEqual(findFileReferenceCandidates(root), [
      'renderer.ts',
      'src/main/index.ts',
      'README.md',
    ])
  })

  it('annotates file references inside .tool-result pre elements', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="tool-result"><pre>src/main/index.ts\nREADME.md</pre></div>'

    await annotateFileReferences(
      root,
      apiWithFileReferences([
        { candidate: 'src/main/index.ts', path: 'src/main/index.ts' },
        { candidate: 'README.md', path: 'README.md' },
      ]),
    )

    const links = [...root.querySelectorAll<HTMLAnchorElement>('a.file-reference-link')]
    assert.equal(links.length, 2)
    assert.equal(links[0]?.dataset['fileReferencePath'], 'src/main/index.ts')
    assert.equal(links[1]?.dataset['fileReferencePath'], 'README.md')
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
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
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

  it('clicking an image path the agent mentioned in tool output opens the image lightbox', async () => {
    // Mirrors how a tool result / assistant message referencing an image
    // (`Saved screenshot to screenshot.png`) gets turned into a clickable
    // file-reference link by `annotateFileReferences`.
    const root = document.createElement('div')
    root.innerHTML = '<div class="tool-result"><pre>Saved screenshot to screenshot.png</pre></div>'
    const api = ((): ApiClient => {
      const base = apiWithFileReferences([{ candidate: 'screenshot.png', path: 'screenshot.png' }])
      return {
        ...base,
        fs: {
          ...base['fs'],
          readFile: async (): Promise<string> => {
            throw new Error('an image reference must not be read as text')
          },
          readImage: async () => PNG,
        },
      } satisfies ApiClient
    })()

    await annotateFileReferences(root, api)
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
    const unbind = bindFileReferenceClicks(root, store, api)

    const link = qsRequired<HTMLAnchorElement>(root, 'a.file-reference-link')
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    unbind()

    // The text/Monaco file viewer never opens for an image.
    assert.equal(store.getState().openFile, null)
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog.open, true)
    assert.equal(qsRequired<HTMLImageElement>(dialog, '.image-expand-image').src, PNG)
    dialog.close()
  })
})
