/**
 * Nothing reconnects the bridge's socket, so once it has closed every later
 * call must fail like the in-flight ones did. Queuing it instead left the
 * caller waiting on a promise that could never settle.
 *
 * Its own file for the reason `protocol-version.test.ts` gives: `electron.ts`
 * is a module-level singleton, so a fresh instance means a fresh test process.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Window } from 'happy-dom'
import { API_PROTOCOL_VERSION } from '@shared/api-protocol.mts'

interface CloseCall {
  code: number
  reason: string
}

/** A WebSocket the test drives: it records what the bridge does to the socket. */
class FakeWebSocket {
  static readonly OPEN = 1
  readonly closes: CloseCall[] = []
  readonly sent: string[] = []
  readyState = FakeWebSocket.OPEN
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code: number, reason: string): void {
    this.readyState = 3
    this.closes.push({ code, reason })
    this.dispatch('close', {})
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }
}

let latest: FakeWebSocket | null = null

function installBrowserGlobals(): Window {
  const token = 'a'.repeat(64)
  const win = new Window({
    url: `http://127.0.0.1/tauri.html?winId=1&wsPort=9&wsToken=${token}`,
  })
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    history: win.history,
    location: win.location,
    WebSocket: class extends FakeWebSocket {
      constructor() {
        super()
        latest = this
      }
    },
    URL,
    URLSearchParams,
  })
  return win
}

describe('ws-bridge after the sidecar connection closes', () => {
  it('rejects a later invoke instead of queuing it forever', async () => {
    installBrowserGlobals()
    const mod = await import('./electron.ts')
    mod.startBridge()
    const ws = latest
    assert.ok(ws, 'the bridge should have opened a socket')
    ws.dispatch('open', {})
    ws.dispatch('message', {
      data: JSON.stringify({ t: 'hello-ok', protocolVersion: API_PROTOCOL_VERSION }),
    })

    const inFlight = mod.ipcRenderer.invoke('workspace:get')
    ws.close(1006, '')
    await assert.rejects(inFlight, /sidecar connection closed/)

    const settled = await Promise.race([
      mod.ipcRenderer.invoke('workspace:get').then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
      ),
      new Promise((resolve) => setTimeout(resolve, 100, 'never settled')),
    ])
    assert.equal(settled, 'sidecar connection closed')
    const sent = ws.sent.length
    mod.ipcRenderer.send('perf:record', {})
    assert.equal(ws.sent.length, sent, 'nothing is written to a closed socket')
  })
})
