import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { installTerminalFileLinks } from './terminal-file-links.ts'

interface FakeTerm {
  rows: number
  registerLinkProvider(provider: ILinkProvider): { dispose(): void }
  provider: ILinkProvider | null
  buffer: {
    active: {
      viewportY: number
      length: number
      getLine(i: number): { translateToString(trim: boolean): string } | undefined
    }
  }
}

function fakeTerm(lines: string[]): FakeTerm {
  return {
    rows: lines.length,
    provider: null,
    registerLinkProvider(provider): { dispose(): void } {
      this.provider = provider
      return { dispose(): void {} }
    },
    buffer: {
      active: {
        viewportY: 0,
        length: lines.length,
        getLine: (i) =>
          i >= 0 && i < lines.length ? { translateToString: () => at(lines, i) } : undefined,
      },
    },
  }
}

function apiWith(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[],
  fileContent = 'x',
): ApiClient {
  return {
    index: {
      query: async () => [],
      resolveFileReferences: async () =>
        resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) })),
    },
    fs: { readFile: async () => fileContent },
  } as unknown as ApiClient
}

function provideLinksAt(term: FakeTerm, bufferLineNumber: number): ILink[] | undefined {
  let captured: ILink[] | undefined
  assert.ok(term.provider)
  term.provider.provideLinks(bufferLineNumber, (links) => {
    captured = links
  })
  return captured
}

describe('terminal file links', () => {
  let store: ReturnType<typeof createStore>
  beforeEach(() => {
    store = createStore({
      workspaceRoot: '/repo',
      filesPaneOpen: false,
      rightPanelMode: 'terminal',
    })
  })

  it('only links references resolved against the index', async () => {
    const term = fakeTerm(['edit src/main/index.ts and notafile.zzz here'])
    const links = installTerminalFileLinks(
      term as unknown as Parameters<typeof installTerminalFileLinks>[0],
      store,
      apiWith([{ candidate: 'src/main/index.ts', path: 'src/main/index.ts' }]),
    )
    links.refresh()
    await new Promise((r) => setTimeout(r, 300))

    const provided = provideLinksAt(term, 1)
    assert.ok(provided)
    assert.equal(provided.length, 1)
    assert.equal(at(provided, 0).text, 'src/main/index.ts')
    // Range spans exactly the path: 1-based, end inclusive of the last cell.
    assert.deepEqual(at(provided, 0).range.start, { x: 6, y: 1 })
    assert.deepEqual(at(provided, 0).range.end, { x: 22, y: 1 })
    links.dispose()
  })

  it('cmd-click reveals a resolved directory in the explorer', async () => {
    const term = fakeTerm(['cd src/renderer/views'])
    let revealed: string | null = null
    store.on('explorer_reveal', (path) => {
      revealed = path
    })
    const links = installTerminalFileLinks(
      term as unknown as Parameters<typeof installTerminalFileLinks>[0],
      store,
      apiWith([{ candidate: 'src/renderer/views', path: 'src/renderer/views', kind: 'directory' }]),
    )
    links.refresh()
    await new Promise((r) => setTimeout(r, 300))

    const link = at(provideLinksAt(term, 1) ?? [], 0)
    link.activate(new window.MouseEvent('click', { metaKey: true }), link.text)
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(revealed, 'src/renderer/views')
    assert.equal(store.getState().openFile, null)
    assert.equal(store.getState().rightPanelMode, 'explorer')
    links.dispose()
  })

  it('cmd-click opens the file at the parsed line/col; plain click is ignored', async () => {
    const term = fakeTerm(['  at src/foo.ts:42:7 in stack'])
    const links = installTerminalFileLinks(
      term as unknown as Parameters<typeof installTerminalFileLinks>[0],
      store,
      apiWith([{ candidate: 'src/foo.ts', path: 'src/foo.ts' }], 'export {}\n'),
    )
    links.refresh()
    await new Promise((r) => setTimeout(r, 300))

    const link = at(provideLinksAt(term, 1) ?? [], 0)
    assert.equal(link.text, 'src/foo.ts:42:7')

    // Plain click: no navigation.
    link.activate(new window.MouseEvent('click'), link.text)
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(store.getState().openFile, null)

    // Cmd-click: opens with reveal.
    link.activate(new window.MouseEvent('click', { metaKey: true }), link.text)
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(store.getState().openFile?.path, 'src/foo.ts')
    assert.deepEqual(store.getState().openFile?.reveal, { line: 42, column: 7 })
    assert.equal(store.getState().rightPanelMode, 'explorer')
    links.dispose()
  })

  it('emits no links before resolution and without a workspace', async () => {
    const term = fakeTerm(['src/main/index.ts'])
    const noWorkspace = createStore({ workspaceRoot: null, rightPanelMode: 'terminal' })
    const links = installTerminalFileLinks(
      term as unknown as Parameters<typeof installTerminalFileLinks>[0],
      noWorkspace,
      apiWith([{ candidate: 'src/main/index.ts', path: 'src/main/index.ts' }]),
    )
    links.refresh()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(provideLinksAt(term, 1), undefined)
    links.dispose()
  })
})
