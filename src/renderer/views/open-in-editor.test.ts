import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ExternalEditorList } from '@shared/types/editors.ts'
import { mountOpenInEditor } from './open-in-editor.ts'
import { qs, qsRequired } from '../dom/helpers.ts'

function createApi(
  list: ExternalEditorList,
  onOpen: (id: string) => Promise<void> = async () => {},
): ApiClient {
  return {
    editors: {
      list: async () => list,
      open: onOpen,
    },
  } as unknown as ApiClient
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('open-in-editor titlebar control', () => {
  it('hides entirely when no editors are detected', async () => {
    const store = createStore({ workspaceRoot: '/repo' })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(host, store, createApi({ editors: [], lastUsedId: null }))
    await settle()

    assert.equal(qsRequired(host, '.open-in-editor').hidden, true)
  })

  it('hides while no folder is open even when editors exist', async () => {
    const store = createStore({ workspaceRoot: null })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(
      host,
      store,
      createApi({ editors: [{ id: 'vscode', name: 'Visual Studio Code' }], lastUsedId: null }),
    )
    await settle()

    assert.equal(qsRequired(host, '.open-in-editor').hidden, true)
  })

  it('shows a single editor with no caret and launches it on primary click', async () => {
    let opened: string | null = null
    const store = createStore({ workspaceRoot: '/repo' })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(
      host,
      store,
      createApi({ editors: [{ id: 'zed', name: 'Zed' }], lastUsedId: null }, async (id) => {
        opened = id
      }),
    )
    await settle()

    assert.equal(qsRequired(host, '.open-in-editor').hidden, false)
    assert.equal(qsRequired(host, '.open-in-editor-label').textContent, 'Open in Zed')
    assert.equal(qsRequired<HTMLButtonElement>(host, '.open-in-editor-caret').hidden, true)

    qsRequired<HTMLButtonElement>(host, '.open-in-editor-primary').click()
    await settle()
    assert.equal(opened, 'zed')
  })

  it('defaults the primary button to the last-used editor', async () => {
    const store = createStore({ workspaceRoot: '/repo' })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(
      host,
      store,
      createApi({
        editors: [
          { id: 'vscode', name: 'Visual Studio Code' },
          { id: 'cursor', name: 'Cursor' },
        ],
        lastUsedId: 'cursor',
      }),
    )
    await settle()

    assert.equal(qsRequired(host, '.open-in-editor-label').textContent, 'Open in Cursor')
    // With more than one editor the caret is available to open the menu.
    assert.equal(qsRequired<HTMLButtonElement>(host, '.open-in-editor-caret').hidden, false)
  })

  it('opens the menu from the caret and launches the picked editor', async () => {
    let opened: string | null = null
    const store = createStore({ workspaceRoot: '/repo' })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(
      host,
      store,
      createApi(
        {
          editors: [
            { id: 'vscode', name: 'Visual Studio Code' },
            { id: 'cursor', name: 'Cursor' },
          ],
          lastUsedId: null,
        },
        async (id) => {
          opened = id
        },
      ),
    )
    await settle()

    assert.equal(qsRequired(host, '.open-in-editor-menu').hasAttribute('hidden'), true)
    qsRequired<HTMLButtonElement>(host, '.open-in-editor-caret').click()
    assert.equal(qsRequired(host, '.open-in-editor-menu').hasAttribute('hidden'), false)

    const cursorItem = qsRequired<HTMLButtonElement>(host, '[data-editor-id="cursor"]')
    cursorItem.click()
    await settle()
    assert.equal(opened, 'cursor')
    // Menu closes after a pick.
    assert.equal(qsRequired(host, '.open-in-editor-menu').hasAttribute('hidden'), true)
  })

  it('appears when a folder is opened after mount', async () => {
    const store = createStore({ workspaceRoot: null })
    const host = document.createElement('div')
    document.body.append(host)

    mountOpenInEditor(
      host,
      store,
      createApi({ editors: [{ id: 'zed', name: 'Zed' }], lastUsedId: null }),
    )
    await settle()
    assert.equal(qsRequired(host, '.open-in-editor').hidden, true)

    store.setState({ workspaceRoot: '/repo' })
    store.emit('workspace_changed')
    assert.equal(qs(host, '.open-in-editor')?.hidden, false)
  })
})
