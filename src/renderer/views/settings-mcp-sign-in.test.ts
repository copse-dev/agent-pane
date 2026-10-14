// Settings → MCP servers: signing in to a remote server that needs OAuth.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

const remote: McpServerStatus = {
  name: 'design',
  transport: 'http',
  state: 'connected',
  toolCount: 1,
  tools: ['get_design'],
  userEnabled: true,
  configDisabled: false,
  origin: 'user',
}

const needsSignIn: McpServerStatus = {
  ...remote,
  state: 'error',
  error: 'Sign-in required',
  auth: 'required',
  toolCount: 0,
  tools: [],
}

const signedIn: McpServerStatus = { ...remote, auth: 'signed-in' }

interface SignInCalls {
  signIn: string[]
  cancel: string[]
  signOut: string[]
  /** Settle the pending `signIn` call. */
  finish: (result: McpServerStatus[] | Error) => void
  /** Push statuses as the main process does on `mcp:status-changed`. */
  pushStatuses: (statuses: McpServerStatus[]) => void
}

function stubApi(servers: McpServerStatus[]): { api: ApiClient; calls: SignInCalls } {
  const base = createFakeApi()
  let current = servers
  let settle: ((result: McpServerStatus[] | Error) => void) | undefined
  const statusHandlers: ((statuses: McpServerStatus[]) => void)[] = []
  const calls: SignInCalls = {
    signIn: [],
    cancel: [],
    signOut: [],
    finish: (result) => settle?.(result),
    pushStatuses: (statuses) => {
      current = statuses
      for (const handler of statusHandlers) handler(statuses)
    },
  }
  const api: ApiClient = {
    ...base,
    mcp: {
      ...base.mcp,
      list: () => Promise.resolve(current),
      listCurated: () => Promise.resolve([]),
      listDeclared: () => Promise.resolve([]),
      onStatusChanged: (handler) => {
        statusHandlers.push(handler)
        return () => undefined
      },
      signIn: (name): Promise<McpServerStatus[]> => {
        calls.signIn.push(name)
        return new Promise((resolve, reject) => {
          settle = (result): void => {
            if (result instanceof Error) {
              reject(result)
              return
            }
            current = result
            resolve(result)
          }
        })
      },
      cancelSignIn: (name) => {
        calls.cancel.push(name)
        return Promise.resolve()
      },
      signOut: (name) => {
        calls.signOut.push(name)
        current = [needsSignIn]
        return Promise.resolve(current)
      },
    },
  }
  return { api, calls }
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openMcp(servers: McpServerStatus[]): Promise<SignInCalls> {
  document.body.innerHTML = ''
  const { api, calls } = stubApi(servers)
  mountSettingsDialog(createStore({ activeProjectId: 'project-1' }), api)
  document.querySelector<HTMLButtonElement>('.settings-nav-btn[data-section="mcp"]')?.click()
  const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')
  assert.ok(dialog)
  dialog.open = true
  dialog.dispatchEvent(new Event('settings-open'))
  await flush()
  document.querySelector<HTMLButtonElement>('.settings-nav-btn[data-section="mcp"]')?.click()
  await flush()
  return calls
}

function row(): HTMLElement {
  const el = document.querySelector<HTMLElement>('#mcp-server-list .mcp-server-row')
  assert.ok(el)
  return el
}

function authButton(): HTMLButtonElement {
  const button = row().querySelector<HTMLButtonElement>('.mcp-auth-btn')
  assert.ok(button)
  return button
}

describe('settings → MCP server sign-in', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a server that needs OAuth as a sign-in, not an error', async () => {
    await openMcp([needsSignIn])
    assert.match(row().querySelector('.mcp-server-summary')?.textContent ?? '', /sign-in required/)
    assert.equal(authButton().textContent, 'Sign in')
    assert.equal(authButton().getAttribute('aria-label'), 'Sign in to design')
    assert.equal(
      row().querySelector('.mcp-server-detail')?.textContent,
      "Sign in to use this server's tools.",
    )
  })

  it('waits for the browser, can be cancelled, and reconnects on success', async () => {
    const calls = await openMcp([needsSignIn])
    authButton().click()
    await flush()
    assert.deepEqual(calls.signIn, ['design'])
    assert.equal(authButton().textContent, 'Cancel sign-in')
    assert.equal(
      row().querySelector('.mcp-server-detail')?.textContent,
      'Continue in your browser to finish signing in.',
    )

    authButton().click()
    assert.deepEqual(calls.cancel, ['design'])

    calls.finish([signedIn])
    await flush()
    assert.match(row().querySelector('.mcp-server-summary')?.textContent ?? '', /connected/)
    assert.equal(row().querySelector('.mcp-server-detail')?.textContent, '1 tool(s): get_design')
    assert.equal(authButton().textContent, 'Sign out')
  })

  it('explains a failed sign-in without the IPC wrapper, and says nothing on cancel', async () => {
    const calls = await openMcp([needsSignIn])
    authButton().click()
    await flush()
    calls.finish(
      new Error(
        "Error invoking remote method 'mcp:sign-in': Error: This server refused to register Copse as a client (HTTP 403). It may only accept approved apps.",
      ),
    )
    await flush()
    assert.equal(
      row().querySelector('.mcp-server-detail')?.textContent,
      'This server refused to register Copse as a client (HTTP 403). It may only accept approved apps.',
    )
    assert.equal(authButton().textContent, 'Sign in')

    authButton().click()
    await flush()
    calls.finish(new Error("Error invoking remote method 'mcp:sign-in': Error: Sign-in cancelled."))
    await flush()
    assert.equal(
      row().querySelector('.mcp-server-detail')?.textContent,
      "Sign in to use this server's tools.",
    )
  })

  it('signs out of a signed-in server', async () => {
    const calls = await openMcp([signedIn])
    assert.equal(authButton().textContent, 'Sign out')
    authButton().click()
    await flush()
    assert.deepEqual(calls.signOut, ['design'])
    assert.equal(authButton().textContent, 'Sign in')
  })

  it('offers no sign-in control for servers that do not use OAuth', async () => {
    await openMcp([{ ...remote, transport: 'stdio' }])
    assert.equal(row().querySelector('.mcp-auth-btn'), null)
  })
  it('offers Sign in when the main process reports a refused sign-in mid-session', async () => {
    const calls = await openMcp([signedIn])
    assert.equal(authButton().textContent, 'Sign out')
    calls.pushStatuses([needsSignIn])
    assert.equal(authButton().textContent, 'Sign in')
    assert.match(row().querySelector('.mcp-server-summary')?.textContent ?? '', /sign-in required/)
  })
})
