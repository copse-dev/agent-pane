/**
 * Regression: Servo can throw from history.replaceState / WebSocket during
 * bridge connect. Those side effects must not run at import time — otherwise
 * preload never reaches exposeInMainWorld('api') and app.js boots with
 * window.api undefined (`can't access property "settings", api… is undefined`).
 */
import { Window } from 'happy-dom'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/** `window.api.settings` as app.js would find it; the shim writes it with `Reflect.set`. */
function exposedSettings(win: Window): unknown {
  const api: unknown = Reflect.get(win, 'api')
  return typeof api === 'object' && api !== null && 'settings' in api ? api.settings : undefined
}

describe('ws-bridge electron shim', () => {
  it('exposes api after import even when connect side effects throw', async () => {
    const token = 'a'.repeat(64)
    const win = new Window({
      url: `http://127.0.0.1/tauri.html?winId=1&wsPort=9&wsToken=${token}`,
    })
    win.history.replaceState = (): never => {
      throw new Error('replaceState boom')
    }
    Object.assign(globalThis, {
      window: win,
      document: win.document,
      history: win.history,
      location: win.location,
      // Throwing from construction — import must still succeed (startBridge owns connect).
      // A plain function is constructible, so `new WebSocket(…)` reaches this throw.
      WebSocket: function ThrowingWebSocket(): never {
        throw new Error('WS boom')
      },
      URL,
      URLSearchParams,
    })

    // Deferred so globals exist before electron.ts reads window.location.
    const mod = await import('./electron.ts')
    // Mirror entry.ts ordering: preload exposes api, then startBridge connects.
    mod.contextBridge.exposeInMainWorld('api', {
      settings: { get: async () => null },
    })
    assert.equal(typeof exposedSettings(win), 'object')

    // Must not throw — connect failures are logged, not fatal.
    mod.startBridge()
    assert.equal(typeof exposedSettings(win), 'object')
  })

  it('answers webUtils.getPathForFile with no path, as Electron does for a pathless file', async () => {
    const mod = await import('./electron.ts')
    assert.equal(mod.webUtils.getPathForFile(new File(['x'], 'notes.md')), '')
  })
})
