import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedCanvasArtefactThreadFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-canvas-artefact-project'
const ACTIVE_THREAD_ID = 'e2e-canvas-active-thread'
const HISTORY_THREAD_ID = 'e2e-canvas-history-thread'
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

/** Drive a built-in tool through the mock model, the same way renderVersion does. */
async function runTool(name: string, args: Record<string, unknown>): Promise<void> {
  await setComposerValue(`[[mcp:${name} ${JSON.stringify(args)}]]`)
  await $('.submit-btn').click()
  await browser.waitUntil(
    () =>
      browser.execute(
        () => !document.querySelector('.submit-btn')?.classList.contains('with-stop'),
      ),
    { timeout: 25_000, timeoutMsg: `expected the ${name} turn to finish` },
  )
}

/** The label of the Browser pane's active tab. */
async function activeTabLabel(): Promise<string | null> {
  return await browser.execute(
    () =>
      document.querySelector('.browser-tabs-tab.is-active .browser-tabs-tab-label')?.textContent ??
      null,
  )
}

const tabLabels = async (): Promise<string[]> =>
  await $$('.browser-tabs-tab-label').map(async (el) => await el.getText())

describe('canvas artefact refresh', () => {
  let labelsAfterFirstRender: string[] = []

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-canvas-artefact-'))
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

  it('leaves a re-render in the background and promotes it only when asked', async () => {
    // The user moves off the artefact tab, as they would while reading something
    // else in the pane.
    await browser.execute(() => {
      const tabs = Array.from(document.querySelectorAll('.browser-tabs-tab'))
      const other = tabs.find(
        (tab) => tab.querySelector('.browser-tabs-tab-label')?.textContent !== 'Sales Dashboard',
      )
      ;(other as HTMLElement | undefined)?.click()
    })
    expect(await activeTabLabel()).not.toEqual('Sales Dashboard')

    // The agent iterates. The new version must land without seizing the tab.
    await renderVersion('v3')
    expect(await activeTabLabel()).not.toEqual('Sales Dashboard')
    expect(await tabLabels()).toEqual(labelsAfterFirstRender)

    // browser_show is the explicit promote step.
    await runTool('browser_show', { title: 'Sales Dashboard' })
    await browser.waitUntil(async () => (await activeTabLabel()) === 'Sales Dashboard', {
      timeout: 20_000,
      timeoutMsg: 'expected browser_show to bring the artefact tab to the front',
    })
    expect(await activeArtefactHeading()).toEqual('v3')
    await saveAppScreenshot('canvas-artefact-promoted.png')
  })

  it('shows a preview thumbnail of the render in the transcript', async () => {
    // End-to-end proof that the artefact reached the headless agent session: the
    // thumbnail is a capturePage() of the agent's own tab, so a card with image
    // data means the mirror loaded the document the canvas is showing. It is
    // also the card that offers to promote a background re-render.
    await browser.execute(() => {
      for (const card of document.querySelectorAll('details.tool-card')) {
        ;(card as HTMLDetailsElement).open = true
        card.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    })
    await $('.canvas-preview-card').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (document.querySelector<HTMLImageElement>('.canvas-preview-image')?.naturalWidth ?? 0) >
            0,
        ),
      { timeout: 20_000, timeoutMsg: 'expected the canvas preview image to load' },
    )
    const preview = await browser.execute(() => {
      const image = document.querySelector<HTMLImageElement>('.canvas-preview-image')
      if (!image) return null
      return {
        src: image.getAttribute('src') ?? '',
        naturalWidth: image.naturalWidth,
        renderedWidth: image.getBoundingClientRect().width,
      }
    })
    if (!preview) throw new Error('expected a canvas preview image')
    expect(preview.src).toContain('data:image/png')
    // A browser must not enlarge the thumbnail: that is what made prototype
    // text visibly blurry when the old 480px capture filled the transcript.
    expect(preview.naturalWidth).toBeGreaterThanOrEqual(Math.ceil(preview.renderedWidth))
    expect(preview.renderedWidth).toBeLessThanOrEqual(1280)
    await saveAppScreenshot('canvas-artefact-preview.png')
  })

  it('does not show one thread’s thumbnail on a same-title card in another thread', async () => {
    await $(`.chat-row[data-thread-id="${HISTORY_THREAD_ID}"]`).click()
    await expect($(`.chat-row[data-thread-id="${HISTORY_THREAD_ID}"]`)).toHaveElementClass(
      'selected',
    )

    const card = $('.tool-card[data-tool-id="historical-canvas-tool"]')
    await card.waitForExist({ timeout: 20_000 })
    await card.$('summary').click()
    await expect(card.$('.tool-result')).toExist()
    expect(await card.$('.canvas-preview-card').isExisting()).toEqual(false)
    await saveAppScreenshot('canvas-preview-thread-isolation.png')
  })
})
