import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-canvas-artefact-project'
const CANVAS_TOOL = 'mcp__copse-canvas__render_html_artefact'
let projectRoot = ''

/**
 * Render one version of the "Sales Dashboard" prototype through the bundled
 * canvas server. The `[[mcp:…]]` directive drives the mock model to call the real
 * tool, so this exercises the production path end to end: MCP result → UI
 * resource extraction → canvas dispatch → Browser pane.
 *
 * The markup deliberately carries no `{`/`}` — the directive's JSON argument is
 * matched only as far as its first closing brace.
 */
async function renderVersion(heading: string): Promise<void> {
  const html = `<!doctype html><title>Sales Dashboard</title><h1 id="version">${heading}</h1>`
  await setComposerValue(
    `[[mcp:${CANVAS_TOOL} ${JSON.stringify({ title: 'Sales Dashboard', html })}]]`,
  )
  await $('.submit-btn').click()
  await browser.waitUntil(
    () =>
      browser.execute(
        () => !document.querySelector('.submit-btn')?.classList.contains('with-stop'),
      ),
    { timeout: 25_000, timeoutMsg: `expected the ${heading} render turn to finish` },
  )
}

/** The heading the active artefact webview is currently showing. */
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

const tabLabels = async (): Promise<string[]> =>
  await $$('.browser-tabs-tab-label').map(async (el) => await el.getText())

describe('canvas artefact refresh', () => {
  let labelsAfterFirstRender: string[] = []

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-canvas-artefact-'))
    resetUserData()
    seedEmptyProject(projectRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      mcpUiCanvasEnabled: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (projectRoot) rmSync(projectRoot, { recursive: true })
  })

  it('renders a prototype from the bundled canvas server into the Browser pane', async () => {
    await renderVersion('v1')
    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'v1', {
      timeout: 20_000,
      timeoutMsg: 'expected the first artefact version to render in the canvas',
    })
    labelsAfterFirstRender = await tabLabels()
    expect(labelsAfterFirstRender.filter((label) => label === 'Sales Dashboard')).toHaveLength(1)
  })

  it('refreshes that tab in place instead of stacking a duplicate', async () => {
    await renderVersion('v2')
    await browser.waitUntil(async () => (await activeArtefactHeading()) === 'v2', {
      timeout: 20_000,
      timeoutMsg: 'expected the open canvas tab to refresh to the second version',
    })
    // Same tabs as before: the prototype the user is looking at became v2 rather
    // than a second "Sales Dashboard" appearing beside it.
    expect(await tabLabels()).toEqual(labelsAfterFirstRender)
    await saveAppScreenshot('canvas-artefact-refresh.png')
  })
})
