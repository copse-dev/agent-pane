/**
 * The client half of the API protocol version handshake (docs/api-protocol.md).
 *
 * `ws-server.ts` refuses a `hello` whose version it does not speak, and
 * `smoke-sidecar.mts` covers that direction against the real sidecar. This
 * covers the other direction, which has no server to exercise it: the browser
 * bridge must refuse a `hello-ok` from a server speaking a different version
 * rather than marking itself ready and flushing queued invokes onto a socket
 * whose shapes it cannot rely on.
 *
 * Its own file because `electron.ts` is a module-level singleton — one socket,
 * one `ready` flag — so a fresh instance means a fresh test process.
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

describe('ws-bridge API protocol version handshake', () => {
  it('refuses a hello-ok from a server speaking another protocol version', async () => {
    installBrowserGlobals()
    const mod = await import('./electron.ts')
    mod.startBridge()
    const ws = latest
    assert.ok(ws, 'the bridge should have opened a socket')

    ws.dispatch('open', {})
    const hello: unknown = JSON.parse(ws.sent[0] ?? '{}')
    assert.deepEqual(hello, {
      t: 'hello',
      winId: 1,
      token: 'a'.repeat(64),
      protocolVersion: API_PROTOCOL_VERSION,
    })

    // An invoke issued before the handshake completes is queued, not sent.
    const pending = mod.ipcRenderer.invoke('workspace:get')
    assert.equal(ws.sent.length, 1, 'queued invokes must wait for hello-ok')

    ws.dispatch('message', {
      data: JSON.stringify({ t: 'hello-ok', protocolVersion: API_PROTOCOL_VERSION + 1 }),
    })

    assert.deepEqual(
      ws.closes,
      [{ code: 4008, reason: 'protocol version mismatch' }],
      'a mismatched server must lose the socket',
    )
    assert.equal(ws.sent.length, 1, 'the queued invoke must never reach a mismatched server')
    await assert.rejects(pending, /API protocol version mismatch/)
  })
})
