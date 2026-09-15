/** Requires real Electron: Chromium CSP and webRequest cannot be tested in happy-dom. */
import { createServer, type Server } from 'node:http'
import { browser, $, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { securePreviewHtml } from '../../src/shared/preview-csp.ts'

interface Guest extends HTMLElement {
  src: string
  getTitle(): string
  loadURL(url: string): Promise<void>
  capturePage(): Promise<{ toDataURL(): string }>
  executeJavaScript<T>(script: string): Promise<T>
}

async function listen(server: Server, host = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  return `http://127.0.0.1:${String(address.port)}`
}

async function navigate(url: string, title: string): Promise<void> {
  await browser.execute((target) => {
    const guest = document.querySelector<Guest>('.browser-tab-panel.is-active webview')
    if (!guest) throw new Error('missing browser guest')
    guest.src = target
  }, url)
  await browser.waitUntil(
    async () =>
      browser.execute((expected) => {
        const guest = document.querySelector<Guest>('.browser-tab-panel.is-active webview')
        return guest?.getTitle() === expected
      }, title),
    { timeout: 15_000, timeoutMsg: `expected preview ${title}` },
  )
}

describe('browser network policy', () => {
  let local: Server
  let external: Server
  let origin: string
  let otherOrigin: string
  const externalRequests: string[] = []
  const localRequests: string[] = []

  before(async () => {
    external = createServer((req, res) => {
      externalRequests.push(req.url ?? '')
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.url === '/user-style.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end('body{background:#fff8ed}#styled{color:#8f2f41;font-weight:700}')
        return
      }
      res.end('external resource')
    })
    otherOrigin = await listen(external)
    local = createServer((req, res) => {
      localRequests.push(req.url ?? '')
      if (req.url === '/redirect') {
        res
          .writeHead(302, {
            Location: `${otherOrigin.replace('127.0.0.1', 'localhost')}/redirect-leak`,
          })
          .end()
        return
      }
      if (req.url === '/own.svg') {
        res.setHeader('Content-Type', 'image/svg+xml')
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#168563"/></svg>',
        )
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(
        `<title>User server</title><link rel="stylesheet" href="${otherOrigin}/user-style.css"><style>body{font:18px system-ui;padding:32px;background:#fff;color:#111}img{width:80px;height:80px}</style><h1>User server</h1><p id="styled">Cross-origin stylesheet loaded.</p><img id="own" src="/own.svg">`,
      )
    })
    origin = await listen(local)
    resetUserData()
    seedEmptyProject(process.cwd(), 'browser-network-policy', {
      webAllowedOrigins: ['http://127.0.0.1:*'],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('.browser-webview').waitForExist()
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const guest = document.querySelector<Guest>('webview')
        try {
          return guest?.getTitle() !== undefined
        } catch {
          return false
        }
      }),
    )
  })

  after(async () => {
    await Promise.all(
      [local, external].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
    resetUserData()
  })

  it('blocks opaque data embeds but preserves styles on user-entered web traffic', async () => {
    // Deliberately omit CSP first: the main-process guard must protect arbitrary data URLs.
    const html = `<title>Data preview</title><img src="${otherOrigin}/data-image"><script>fetch('${otherOrigin}/data-fetch').catch(()=>{});</script>`
    await navigate(`data:text/html,${encodeURIComponent(html)}`, 'Data preview')
    await browser.execute(async () => {
      const guest = document.querySelector<Guest>('webview')
      await guest?.executeJavaScript('new Promise(resolve => setTimeout(resolve, 150))')
    })
    expect(externalRequests).toEqual([])
    await navigate(`data:text/html,${encodeURIComponent(securePreviewHtml(html))}`, 'Data preview')

    const address = await $('.browser-tab-panel.is-active .browser-url-input')
    await address.setValue(origin)
    await browser.keys('Enter')
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const guest = document.querySelector<Guest>('webview')
          return guest?.getTitle() === 'User server'
        }),
      { timeout: 15_000, timeoutMsg: 'expected the user-entered server to load' },
    )
    await browser.waitUntil(async () =>
      browser.execute(async () => {
        const guest = document.querySelector<Guest>('webview')
        return guest?.executeJavaScript<boolean>(
          'document.querySelector("#own").naturalWidth > 0 && getComputedStyle(document.querySelector("#styled")).color === "rgb(143, 47, 65)"',
        )
      }),
    )
    const result = await browser.execute(async () => {
      const guest = document.querySelector<Guest>('webview')
      return guest?.executeJavaScript<{ own: number; color: string; background: string }>(
        '({own: document.querySelector("#own").naturalWidth, color: getComputedStyle(document.querySelector("#styled")).color, background: getComputedStyle(document.body).backgroundColor})',
      )
    })
    expect(result?.own).toBe(80)
    expect(result?.color).toBe('rgb(143, 47, 65)')
    expect(result?.background).toBe('rgb(255, 248, 237)')
    expect(localRequests).toContain('/own.svg')
    expect(externalRequests).toContain('/user-style.css')
    // Native webview surfaces are blank in WebDriver's app screenshot on macOS.
    // Capture the guest compositor so the restored user stylesheet is reviewable.
    const screenshot = await browser.execute(async () => {
      const guest = document.querySelector<Guest>('webview')
      if (!guest) throw new Error('missing guest')
      guest.style.width = '720px'
      guest.style.height = '480px'
      await guest.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      return (await guest.capturePage()).toDataURL()
    })
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeFileSync(
      join(E2E_SCREENSHOT_DIR, 'browser-preview-network-policy.png'),
      Buffer.from(screenshot.split(',')[1] ?? '', 'base64'),
    )

    // A server redirect gets a fresh allowlist check (no live external host needed).
    const redirectError = await browser.execute(async (url) => {
      const guest = document.querySelector<Guest>('webview')
      if (!guest) throw new Error('missing guest')
      try {
        await guest.loadURL(url)
        return ''
      } catch (error) {
        return String(error)
      }
    }, `${origin}/redirect`)
    expect(redirectError).toMatch(/ERR_(FAILED|BLOCKED_BY_CLIENT)/)
    expect(externalRequests).not.toContain('/redirect-leak')
  })
  it('blocks data previews from navigating or opening a network tab, while host navigation still works', async () => {
    externalRequests.length = 0
    await navigate('data:text/html,<title>Navigation probe</title>', 'Navigation probe')
    const tabsBefore = await browser.execute(() => document.querySelectorAll('webview').length)
    await browser.execute(async (target) => {
      const guest = document.querySelector<Guest>('webview')
      await guest?.executeJavaScript(
        `window.open(${JSON.stringify(target + '/popup')}); location.href = ${JSON.stringify(target + '/navigation')}`,
      )
      await guest?.executeJavaScript('new Promise(resolve => setTimeout(resolve, 300))')
    }, otherOrigin)
    expect(externalRequests).toEqual([])
    expect(await browser.execute(() => document.querySelectorAll('webview').length)).toBe(
      tabsBefore,
    )
    await navigate(origin, 'User server')
    expect(externalRequests).toContain('/user-style.css')
  })
})
