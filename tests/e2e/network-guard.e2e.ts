/**
 * The e2e outbound network guard (docs/testing-strategy.md#outbound-network-guard).
 * Real Electron is the point: only Chromium's own network stack shows whether
 * `--proxy-server` covers a `<webview>` guest's partition as well as loopback.
 * Each public request here is declared with `expectNetworkEgress`, so the root
 * hook requires the guard to have seen and refused it instead of failing the test.
 */
import { createServer, type Server } from 'node:http'
import { browser, $, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { makeE2eScratchDir } from './helpers/scratch-dir.ts'
import { expectNetworkEgress, networkGuardMode } from './helpers/network-guard.ts'

/** `log` forwards what `enforce` refuses; each test asserts the half its mode owns. */
const enforcing = networkGuardMode(process.env['COPSE_E2E_NETWORK_GUARD']) === 'enforce'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  return `http://127.0.0.1:${String(address.port)}`
}

/** Load `url` in the active browser tab's guest and report how it ended. */
async function loadInGuest(url: string): Promise<string> {
  return browser.execute(async (target) => {
    const guest = document.querySelector<Electron.WebviewTag>(
      '.browser-tab-panel.is-active webview',
    )
    if (!guest) throw new Error('missing browser guest')
    try {
      await guest.loadURL(target)
      return `loaded ${guest.getTitle()}`
    } catch (error) {
      return `failed ${error instanceof Error ? error.message : String(error)}`
    }
  }, url)
}

describe('e2e outbound network guard', () => {
  let local: Server
  let origin: string

  before(async () => {
    local = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.end('<title>Loopback fixture</title><h1>loopback</h1>')
    })
    origin = await listen(local)
    resetUserData()
    seedEmptyProject(makeE2eScratchDir('.network-guard-project-'), 'network-guard')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('.browser-webview').waitForExist()
  })

  after(async () => {
    await new Promise<void>((resolve) =>
      local.close(() => {
        resolve()
      }),
    )
    resetUserData()
  })

  it('refuses a public fetch from a page in the browser pane', async () => {
    // The app renderer's own CSP stops a public fetch before it reaches the
    // network, so exercise Chromium's network stack from a guest page instead.
    expect(await loadInGuest(origin)).toBe('loaded Loopback fixture')
    expectNetworkEgress('example.com')
    const outcome = await browser.execute(async () => {
      const guest = document.querySelector<Electron.WebviewTag>(
        '.browser-tab-panel.is-active webview',
      )
      if (!guest) throw new Error('missing browser guest')
      const value: unknown = await guest.executeJavaScript(
        // no-cors: an opaque response resolves when forwarded, so only a refusal rejects.
        "fetch('https://example.com/', { cache: 'no-store', mode: 'no-cors' }).then((r) => 'opaque ' + r.type, (e) => 'refused ' + e.name)",
      )
      return String(value)
    })
    expect(outcome).toBe(enforcing ? 'refused TypeError' : 'opaque opaque')
  })

  it('refuses a browser-pane navigation to a public host', async () => {
    expectNetworkEgress('example.org')
    // Plain HTTP reaches the guard proxy as a request, so the guest renders its refusal.
    await loadInGuest('http://example.org/')
    const body = await browser.execute(async () => {
      const guest = document.querySelector<Electron.WebviewTag>(
        '.browser-tab-panel.is-active webview',
      )
      const value: unknown = await guest?.executeJavaScript('document.body.innerText')
      return String(value)
    })
    if (enforcing) expect(body).toContain('[e2e-network-guard] example.org refused')
    else expect(body).not.toContain('[e2e-network-guard]')
  })

  it('still reaches a loopback server from the browser pane', async () => {
    expect(await loadInGuest(origin)).toBe('loaded Loopback fixture')
  })
})
