import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { PNG } from 'pngjs'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, seedCanvasArtefactThreadFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * Quitting Copse used to throw the canvas away: the Browser pane holds each
 * artefact in a live guest, so the tab — and the prototype in it — died with the
 * window. This drives the real path end to end (MCP canvas tool → artefact
 * dispatch → Browser pane), relaunches the app on the same profile, and asserts
 * the pane comes back holding the same prototype.
 */

const PROJECT_ID = 'e2e-browser-session-project'
const ACTIVE_THREAD_ID = 'e2e-browser-session-thread'
const HISTORY_THREAD_ID = 'e2e-browser-session-history'
const CANVAS_TOOL = 'mcp__copse-canvas__render_html_artefact'
let temporaryRoot = ''
let projectRoot = ''

/** The label of every tab in the Browser pane, in order. */
const tabLabels = async (): Promise<string[]> =>
  await $$('.browser-tabs-tab-label').map(async (el) => await el.getText())

/** The heading the active artefact guest is currently showing. */
async function activeArtefactHeading(): Promise<string | null> {
  return await browser.execute(async () => {
    const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    const text = await webview?.executeJavaScript?.(
      'document.getElementById("version")?.textContent ?? null',
    )
    return typeof text === 'string' ? text : null
  })
}

/** Wait after screenshot framing for the native guest to paint its heading. */
async function waitForArtefactPaint(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const capture = await browser.execute(async () => {
        const guest = document.querySelector('.browser-tab-panel.is-active webview') as
          | (HTMLElement & {
              executeJavaScript<T>(code: string): Promise<T>
              capturePage(): Promise<{ toDataURL(): string }>
            })
          | null
        if (!guest) return null
        const frame = guest.getBoundingClientRect()
        const state = await guest.executeJavaScript<{
          ready: boolean
          width: number
          height: number
          heading: { x: number; y: number; width: number; height: number } | null
        }>(`(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const heading = document.getElementById('version');
          const rect = heading?.getBoundingClientRect();
          return {
            ready: document.readyState === 'complete' && heading?.textContent === 'restored',
            width: innerWidth, height: innerHeight,
            heading: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null
          };
        })()`)
        if (
          !state.ready ||
          !state.heading ||
          Math.abs(state.width - frame.width) > 1 ||
          Math.abs(state.height - frame.height) > 1
        )
          return null
        return { ...state, png: (await guest.capturePage()).toDataURL() }
      })
      if (!capture?.heading || capture.width <= 0 || capture.height <= 0) return false
      const image = PNG.sync.read(Buffer.from(capture.png.split(',')[1] ?? '', 'base64'))
      const scaleX = image.width / capture.width
      const scaleY = image.height / capture.height
      const left = Math.max(0, Math.floor(capture.heading.x * scaleX))
      const top = Math.max(0, Math.floor(capture.heading.y * scaleY))
      const right = Math.min(
        image.width,
        Math.ceil((capture.heading.x + capture.heading.width) * scaleX),
      )
      const bottom = Math.min(
        image.height,
        Math.ceil((capture.heading.y + capture.heading.height) * scaleY),
      )
      // A populated guest DOM can still have a white native surface. Require
      // actual dark heading pixels, without depending on exact font rasterization.
      let darkPixels = 0
      let lightPixels = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * image.width + x) * 4
          if (
            image.data[offset]! < 160 &&
            image.data[offset + 1]! < 160 &&
            image.data[offset + 2]! < 160 &&
            image.data[offset + 3]! > 200
          ) {
            darkPixels++
          }
          if (
            image.data[offset]! > 240 &&
            image.data[offset + 1]! > 240 &&
            image.data[offset + 2]! > 240 &&
            image.data[offset + 3]! > 200
          )
            lightPixels++
          if (darkPixels > 20 && lightPixels > 20) return true
        }
      }
      return false
    },
    {
      timeout: 20_000,
      timeoutMsg: 'expected the framed canvas guest to paint the restored heading',
    },
  )
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

describe('browser session restore', function () {
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    temporaryRoot = mkdtempSync(join(tmpdir(), 'copse-browser-session-'))
    projectRoot = join(temporaryRoot, 'browser-session')
    mkdirSync(projectRoot)
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedCanvasArtefactThreadFixture(projectRoot, PROJECT_ID, ACTIVE_THREAD_ID, HISTORY_THREAD_ID)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true })
  })

  it('renders a prototype into the Browser pane', async () => {
    const html =
      '<!doctype html><title>Sales Dashboard</title>' +
      '<style>body{margin:24px;background:#fff;color:#222;font:16px system-ui}</style>' +
      '<h1 id="version">restored</h1><p>Sales Dashboard is ready.</p>'
    const scenario = await prepareMockToolTurn(
      'Render the sales dashboard.',
      { name: CANVAS_TOOL, args: { title: 'Sales Dashboard', html } },
      'The sales dashboard is ready in the Browser pane.',
    )
    await $('.submit-btn').click()
    await expectAssistantReply('The sales dashboard is ready in the Browser pane.')
    await waitForAgentIdle(25_000)
    await scenario.assertComplete()

    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'restored', {
      timeout: 20_000,
      timeoutMsg: 'expected the artefact to render in the canvas',
    })
    expect(await tabLabels()).toContain('Sales Dashboard')
    await waitForAgentIdle()
    await saveElementScreenshot('#app', 'browser-session-restore-before-quit.png', {
      beforeCapture: waitForArtefactPaint,
    })
  })

  it('brings the canvas tab back when Copse is reopened', async () => {
    // The pane records its tabs on a debounce, so give that write its turn
    // before the relaunch — the shutdown freezes window state, by design, so a
    // record that has not landed by then never will.
    await browser.pause(1_500)

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // The window quit with the canvas in front, so it comes back in front —
    // no clicking through to the Browser pane to find yesterday's work.
    await $('#pane-files').waitForDisplayed({ timeout: 20_000 })
    await browser.waitUntil(async () => (await tabLabels()).includes('Sales Dashboard'), {
      timeout: 20_000,
      timeoutMsg: 'expected the canvas tab to be restored after relaunch',
    })
    expect(await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()).toBe(
      'Sales Dashboard',
    )

    // And it is the artefact itself, read back from the thread's canvas store,
    // not an empty tab wearing its name.
    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'restored', {
      timeout: 20_000,
      timeoutMsg: 'expected the restored tab to render the saved artefact',
    })

    // Exercise the transcript entry point after relaunch too. Closing the live
    // tab leaves only the durable card; Open must re-read the saved artefact and
    // return it to one active tab rather than selecting an empty shell.
    await $('.browser-tabs-tab.is-active .browser-tabs-tab-close').click()
    await browser.waitUntil(async () => !(await tabLabels()).includes('Sales Dashboard'), {
      timeout: 10_000,
      timeoutMsg: 'expected the restored canvas tab to close',
    })
    await browser.execute(() => {
      for (const card of document.querySelectorAll('details.tool-card')) {
        ;(card as HTMLDetailsElement).open = true
        card.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    })
    const open = await $('.canvas-preview-card button')
    await open.waitForDisplayed({ timeout: 20_000 })
    await open.click()

    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'restored', {
      timeout: 20_000,
      timeoutMsg: 'expected preview Open to re-render the saved artefact after relaunch',
    })
    expect((await tabLabels()).filter((label) => label === 'Sales Dashboard')).toHaveLength(1)
    await saveElementScreenshot('#app', 'browser-session-restore-after-relaunch.png', {
      beforeCapture: waitForArtefactPaint,
    })
  })
})
