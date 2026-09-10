import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
let requests = 0
let probeUrl = ''
const server = createServer((_request, response) => {
  requests++
  response.end('unexpected request')
})

describe('isolated mermaid diagram rendering', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No probe server port')
    probeUrl = `http://127.0.0.1:${String(address.port)}`
    const { resetUserData, seedMermaidDiagramFixture } = await import('./helpers/seed-config.ts')
    resetUserData()
    seedMermaidDiagramFixture(process.cwd())
    await browser.reloadSession()
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const { resetUserData } = await import('./helpers/seed-config.ts')
    resetUserData()
  })

  it('renders and expands in opaque frames without inserting SVG into the app', async () => {
    const selector = '.message-text iframe.mermaid-frame[data-rendered="true"]'
    await $(selector).waitForExist({ timeout: 40_000 })
    const frame = await $(selector)
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    const hostState = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe.mermaid-frame')
      return {
        svgCount: document.querySelectorAll('.mermaid-diagram svg').length,
        inaccessibleDocument: frame?.contentDocument === null,
        width: frame?.getBoundingClientRect().width ?? 0,
        height: frame?.getBoundingClientRect().height ?? 0,
      }
    })
    expect(hostState.svgCount).toBe(0)
    expect(hostState.inaccessibleDocument).toBe(true)
    expect(hostState.width).toBeGreaterThan(50)
    expect(hostState.height).toBeGreaterThan(50)

    await browser.switchFrame(frame)
    const isolation = await browser.execute(() => {
      let parentBlocked = false
      let parentApiBlocked = false
      try {
        void window.parent.document.body
      } catch {
        parentBlocked = true
      }
      try {
        Reflect.get(window.parent, 'api')
      } catch {
        parentApiBlocked = true
      }
      return {
        parentBlocked,
        parentApiBlocked,
        ownApi: 'api' in window,
        svg: Boolean(document.querySelector('svg')),
        text: document.body.textContent,
      }
    })
    expect(isolation.parentBlocked).toBe(true)
    expect(isolation.parentApiBlocked).toBe(true)
    expect(isolation.ownApi).toBe(false)
    expect(isolation.svg).toBe(true)
    expect(isolation.text).toContain('Agent')
    await browser.switchToParentFrame()

    await saveAppScreenshot('mermaid-isolated-inline.png')
    await $('.mermaid-diagram--folded').click()
    await $('dialog.mermaid-expand-dialog[open]').waitForExist()
    await $('dialog .mermaid-frame[data-rendered="true"]').waitForExist({ timeout: 40_000 })
    expect(await $('dialog .mermaid-expand-stage svg').isExisting()).toBe(false)
    await saveAppScreenshot('mermaid-diagram-agent-loop.png')
    await $('.mermaid-expand-close').click()
    expect(await $('dialog.mermaid-expand-dialog').isDisplayed()).toBe(false)
    expect(await $('dialog .mermaid-frame').isExisting()).toBe(false)
  })

  it('blocks network, inline script, navigation, and unsolicited parent messages even with code execution in the frame', async () => {
    const frame = await $('.message-text iframe.mermaid-frame')
    const originalHeight = await frame.getCSSProperty('height')
    await browser.switchFrame(frame)
    const probes = await browser.executeAsync((url, done) => {
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', (event) =>
        violations.push(event.effectiveDirective),
      )
      const script = document.createElement('script')
      script.textContent = 'document.body.dataset.inlineExecuted = "yes"'
      document.body.append(script)
      const img = document.createElement('img')
      img.src = `${url}/diagram-image-probe`
      document.body.append(img)
      window.parent.postMessage({ type: 'rendered', width: 1e9, height: 1e9 }, '*')
      void fetch(`${url}/diagram-fetch-probe`).then(
        () =>
          done({
            fetchBlocked: false,
            inlineExecuted: document.body.dataset['inlineExecuted'],
            violations,
          }),
        () =>
          setTimeout(
            () =>
              done({
                fetchBlocked: true,
                inlineExecuted: document.body.dataset['inlineExecuted'] ?? null,
                violations,
              }),
            100,
          ),
      )
    }, probeUrl)
    expect(probes.fetchBlocked).toBe(true)
    expect(probes.inlineExecuted).toBe(null)
    expect(probes.violations).toContain('connect-src')
    expect(probes.violations).toContain('img-src')
    expect(probes.violations).toContain('script-src-elem')
    await browser.execute((url) => {
      window.location.href = `${url}/diagram-navigation-probe`
    }, probeUrl)
    await browser.switchToParentFrame()
    await browser.switchFrame(await $('.message-text iframe.mermaid-frame'))
    const navigation = await browser.execute(() => window.location.href)
    // Chromium replaces the cancelled navigation with its local error document.
    // The security assertion is that the destination receives no request.
    expect(navigation).toBe('chrome-error://chromewebdata/')
    await browser.switchToParentFrame()
    expect((await frame.getCSSProperty('height')).value).toBe(originalHeight.value)
    await browser.pause(100)
    expect(requests).toBe(0)
  })
})
