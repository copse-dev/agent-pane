import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedCanvasArtefactThreadFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

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

describe('browser session restore', function () {
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-browser-session-'))
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
    if (projectRoot) rmSync(projectRoot, { recursive: true })
  })

  it('renders a prototype into the Browser pane', async () => {
    const html = '<!doctype html><title>Sales Dashboard</title><h1 id="version">restored</h1>'
    await setComposerValue(
      `[[mcp:${CANVAS_TOOL} ${JSON.stringify({ title: 'Sales Dashboard', html })}]]`,
    )
    await $('.submit-btn').click()
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector('.submit-btn')?.classList.contains('with-stop'),
        ),
      { timeout: 25_000, timeoutMsg: 'expected the render turn to finish' },
    )

    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'restored', {
      timeout: 20_000,
      timeoutMsg: 'expected the artefact to render in the canvas',
    })
    expect(await tabLabels()).toContain('Sales Dashboard')
    await saveAppScreenshot('browser-session-restore-before-quit.png')
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
    await saveAppScreenshot('browser-session-restore-after-relaunch.png')
  })
})
