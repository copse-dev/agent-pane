// Settings → MCP servers: adding, editing and removing servers in Copse's own mcp.json.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import type {
  McpUserServerInput,
  McpUserServerList,
  McpUserServerSaveResult,
} from '@shared/types/mcp-user-servers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

const USER_PATH = '/user-data/mcp.json'

const docs: McpServerStatus = {
  name: 'docs',
  transport: 'stdio',
  state: 'connected',
  toolCount: 1,
  tools: ['search'],
  source: USER_PATH,
  userEnabled: true,
  configDisabled: false,
  origin: 'user',
}

const cursorServer: McpServerStatus = {
  ...docs,
  name: 'cursor-one',
  source: '/home/me/.cursor/mcp.json',
}

const docsList: McpUserServerList = {
  path: USER_PATH,
  servers: [
    {
      transport: 'stdio',
      name: 'docs',
      command: 'npx',
      args: ['-y', 'docs'],
      env: [{ key: 'TOKEN' }],
    },
  ],
}

interface EditorCalls {
  saves: { input: McpUserServerInput; previousName: string | undefined }[]
  removes: string[]
  nextSave: McpUserServerSaveResult
}

function stubApi(): { api: ApiClient; calls: EditorCalls } {
  const base = createFakeApi()
  const calls: EditorCalls = {
    saves: [],
    removes: [],
    nextSave: { ok: true, list: docsList },
  }
  const api: ApiClient = {
    ...base,
    mcp: {
      ...base.mcp,
      list: () => Promise.resolve([docs, cursorServer]),
      listCurated: () => Promise.resolve([]),
      listDeclared: () => Promise.resolve([]),
      listUserServers: () => Promise.resolve(docsList),
      saveUserServer: (input, previousName) => {
        calls.saves.push({ input, previousName })
        return Promise.resolve(calls.nextSave)
      },
      removeUserServer: (name) => {
        calls.removes.push(name)
        return Promise.resolve({ ok: true, list: { path: USER_PATH, servers: [] } })
      },
    },
  }
  return { api, calls }
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openMcp(): Promise<EditorCalls> {
  document.body.innerHTML = ''
  const { api, calls } = stubApi()
  mountSettingsDialog(createStore({ activeProjectId: 'project-1' }), api)
  const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
  assert.ok(dialog)
  dialog.open = true
  dialog.dispatchEvent(new Event('settings-open'))
  await flush()
  document.querySelector<HTMLButtonElement>('.settings-nav-btn[data-section="mcp"]')?.click()
  await flush()
  return calls
}

function q<E extends Element = HTMLElement>(selector: string): E {
  const found = document.querySelector<E>(selector)
  assert.ok(found, selector)
  return found
}

function type(selector: string, value: string): void {
  const input = q<HTMLInputElement | HTMLTextAreaElement>(selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('settings → MCP server editor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('offers Edit and Remove only on servers from Copse’s own config', async () => {
    await openMcp()
    const own = q('#mcp-server-list .mcp-server-row[data-mcp-server="docs"]')
    const other = q('#mcp-server-list .mcp-server-row[data-mcp-server="cursor-one"]')
    assert.ok(own.querySelector('.mcp-edit-btn'))
    assert.ok(own.querySelector('.mcp-remove-btn'))
    assert.equal(other.querySelector('.mcp-edit-btn'), null)
    assert.equal(other.querySelector('.mcp-remove-btn'), null)
  })

  it('adds a stdio server from the form', async () => {
    const calls = await openMcp()
    assert.equal(q('#mcp-server-editor').hidden, true)
    q<HTMLButtonElement>('#mcp-add-btn').click()
    assert.equal(q('#mcp-server-editor').hidden, false)
    type('#mcp-editor-name', 'everything')
    type('#mcp-editor-command', 'npx')
    type('#mcp-editor-args', '-y\n@modelcontextprotocol/server-everything\n')
    q<HTMLButtonElement>('.mcp-editor-secrets button:not(.mcp-editor-secret-remove)').click()
    type('.mcp-editor-secret-key', 'API_KEY')
    type('.mcp-editor-secret-value', 'secret')
    q<HTMLButtonElement>('#mcp-editor-save').click()
    await flush()
    assert.deepEqual(calls.saves, [
      {
        input: {
          transport: 'stdio',
          name: 'everything',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything', ''],
          env: [{ key: 'API_KEY', value: 'secret' }],
        },
        previousName: undefined,
      },
    ])
    assert.equal(q('#mcp-server-editor').hidden, true)
  })

  it('edits without resending a stored secret it was never given', async () => {
    const calls = await openMcp()
    q<HTMLButtonElement>('.mcp-server-row[data-mcp-server="docs"] .mcp-edit-btn').click()
    assert.equal(q<HTMLInputElement>('#mcp-editor-name').value, 'docs')
    assert.equal(q<HTMLTextAreaElement>('#mcp-editor-args').value, '-y\ndocs')
    const value = q<HTMLInputElement>('.mcp-editor-secret-value')
    assert.equal(value.type, 'password')
    assert.equal(value.value, '')
    assert.equal(value.placeholder, 'Saved value (unchanged)')
    q<HTMLButtonElement>('#mcp-editor-save').click()
    await flush()
    assert.equal(calls.saves[0]?.previousName, 'docs')
    assert.deepEqual(calls.saves[0]?.input, {
      transport: 'stdio',
      name: 'docs',
      command: 'npx',
      args: ['-y', 'docs'],
      env: [{ key: 'TOKEN' }],
    })
  })

  it('marks the rejected field and keeps the form open', async () => {
    const calls = await openMcp()
    calls.nextSave = { ok: false, field: 'url', message: 'Enter an http:// or https:// URL.' }
    q<HTMLButtonElement>('#mcp-add-btn').click()
    const transport = q<HTMLSelectElement>('#mcp-editor-transport')
    transport.value = 'http'
    transport.dispatchEvent(new Event('change', { bubbles: true }))
    assert.equal(q('[data-transport="stdio"]').hidden, true)
    assert.equal(q('[data-transport="http"]').hidden, false)
    type('#mcp-editor-name', 'remote')
    type('#mcp-editor-url', 'ftp://nope')
    q<HTMLButtonElement>('#mcp-editor-save').click()
    await flush()
    assert.equal(calls.saves[0]?.input.transport, 'http')
    assert.equal(q('#mcp-editor-url').getAttribute('aria-invalid'), 'true')
    assert.match(q('#mcp-editor-status').textContent ?? '', /http:\/\/ or https:\/\//)
    assert.equal(q('#mcp-server-editor').hidden, false)
  })
})
