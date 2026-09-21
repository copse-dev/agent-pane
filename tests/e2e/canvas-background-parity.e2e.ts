import assert from 'node:assert/strict'
import { $, $$, browser } from '@wdio/globals'
import type { MockScriptStep } from '@copse/llm/mock-script'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForPromptReady } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-canvas-background-parity'
const TITLE = 'Transparent Canvas Parity'
const OVERRIDE_TITLE = 'Explicit Canvas Background'
const CANVAS_TOOL = 'mcp__copse-canvas__render_html_artefact'

const EXPLICIT_BACKGROUND = [226, 166, 58, 255]

const TRANSPARENT_ARTEFACT = `<div id="canvas-background-probe">
  <h1>Theme-backed canvas</h1>
  <p>The document is transparent, so Copse supplies this surface.</p>
</div>
<style>
  html,
  body {
    min-height: 100%;
    margin: 0;
    background: transparent;
  }
  #canvas-background-probe {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 32px;
    color: white;
  }
</style>
`

const OVERRIDDEN_ARTEFACT = `<div id="canvas-background-probe">
  <h1>Artifact-owned canvas</h1>
  <p>This document explicitly overrides Copse's default surface.</p>
</div>
<style>
  html,
  body {
    min-height: 100%;
    margin: 0;
    background: rgb(${String(EXPLICIT_BACKGROUND[0])}, ${String(EXPLICIT_BACKGROUND[1])}, ${String(EXPLICIT_BACKGROUND[2])});
  }
  #canvas-background-probe {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 32px;
    color: #1e1e1e;
  }
</style>
`

// The local mock provider renders through MCP; inline visualization control
// frames are handled by the ACP executor only.
const SCRIPT = [
  {
    when: 'render the transparent canvas',
    tool: { name: CANVAS_TOOL, args: { title: TITLE, html: TRANSPARENT_ARTEFACT } },
  },
  {
    when: 'render the explicit canvas background',
    tool: { name: CANVAS_TOOL, args: { title: OVERRIDE_TITLE, html: OVERRIDDEN_ARTEFACT } },
  },
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  const status = await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (value: unknown) => Promise<{ steps: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
  assert.equal(status.steps, SCRIPT.length)
}

async function resolvedBodyBackgroundPixel(): Promise<number[]> {
  return browser.execute(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable')
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  })
}

async function previewCornerPixel(title: string): Promise<number[]> {
  return browser.execute((expectedTitle) => {
    const card = Array.from(document.querySelectorAll('.canvas-preview-card')).find(
      (candidate) =>
        candidate.querySelector('.canvas-preview-title')?.textContent === expectedTitle,
    )
    const image = card?.querySelector<HTMLImageElement>('.canvas-preview-image')
    if (!image?.complete || !image.naturalWidth) throw new Error('canvas preview is not ready')
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable')
    // Honor the capture's embedded display profile (e.g. Display P3 on macOS)
    // before comparing its pixel with the CSS color resolved in sRGB.
    context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  }, title)
}

async function pinPreviewRollupOpen(expectedTitle: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((title) => {
        const card = Array.from(
          document.querySelectorAll<HTMLElement>('.canvas-preview-card'),
        ).find(
          (candidate) => candidate.querySelector('.canvas-preview-title')?.textContent === title,
        )
        const rollup = card?.closest<HTMLDetailsElement>('details.tool-card-rollup')
        const summary = rollup?.querySelector<HTMLElement>(':scope > summary')
        if (!rollup || !summary) return false

        // Auto-revealed rollups have no user preference and can be compacted
        // while the preview image is loading. Use the real summary handler to
        // record an explicit open choice, then let the caller reacquire the
        // current card before interacting with it.
        if (rollup.open) summary.click()
        summary.click()
        return rollup.open && rollup.dataset['userToggled'] === '1'
      }, expectedTitle),
    { timeout: 20_000, timeoutMsg: 'expected the canvas preview rollup to open' },
  )
}

async function renderCanvas(prompt: string, expectedToolCount: number): Promise<void> {
  await setComposerValue(prompt)
  await $('.submit-btn').click()
  await browser.waitUntil(
    async () =>
      browser.execute(
        (count) =>
          !document.querySelector('.submit-btn')?.classList.contains('with-stop') &&
          document.querySelectorAll('.tool-card[data-tool-id][data-status="done"]').length ===
            count,
        expectedToolCount,
      ),
    { timeout: 30_000, timeoutMsg: 'expected the canvas render tool to finish' },
  )
  // MCP previews are built lazily inside the completed tool's disclosure.
  await browser.execute(() => {
    for (const rollup of document.querySelectorAll<HTMLDetailsElement>('.tool-card-rollup')) {
      if (!rollup.open) rollup.querySelector('summary')?.click()
    }
  })
  await browser.execute(() => {
    for (const tool of document.querySelectorAll<HTMLDetailsElement>('.tool-card[data-tool-id]')) {
      if (!tool.open) tool.querySelector('summary')?.click()
    }
  })
}

describe('canvas background parity', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''

    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      model: 'claude-sonnet-4-6',
      mcpUiCanvasEnabled: true,
      theme: 'dark',
      uiTintColor: '#244c25',
      uiTintStrength: 'strong',
      autoPortraitRightPanel: false,
      rightPanelPosition: 'side',
    })
    await browser.reloadSession()
  })

  after(async () => {
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('matches a transparent preview to the live dark canvas', async function () {
    this.timeout(90_000)
    await waitForPromptReady()
    await installMockScript()

    await renderCanvas('Please render the transparent canvas.', 1)

    const initialCard = $('.canvas-preview-card')
    await initialCard.waitForExist({ timeout: 20_000 })
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const candidate = document.querySelector<HTMLImageElement>(selector)
          return candidate?.complete === true && candidate.naturalWidth > 0
        }, '.canvas-preview-image'),
      { timeout: 20_000, timeoutMsg: 'expected canvas preview image to load' },
    )

    const preview = await $('.canvas-preview-card .canvas-preview-image').getAttribute('src')
    assert.ok(preview?.startsWith('data:image/png;base64,'))
    const previewCorner = await previewCornerPixel(TITLE)
    const themePixel = await resolvedBodyBackgroundPixel()
    // An 8-bit display-profile round trip can round an RGB channel by one.
    assert.equal(previewCorner.length, themePixel.length)
    for (const [channel, expected] of themePixel.entries()) {
      assert.ok(
        Math.abs((previewCorner[channel] ?? -255) - expected) <= (channel === 3 ? 0 : 1),
        `preview ${JSON.stringify(previewCorner)} should match theme ${JSON.stringify(themePixel)}`,
      )
    }

    await pinPreviewRollupOpen(TITLE)
    const currentCard = $('.canvas-preview-card')
    await currentCard.$('button').click()
    await $('.browser-tab-panel.is-active .browser-webview').waitForExist({ timeout: 20_000 })
    const surfaces = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>(
        '.browser-tab-panel.is-active .browser-webview-host',
      )
      if (!host) throw new Error('active browser webview host missing')
      return {
        app: getComputedStyle(document.body).backgroundColor,
        canvas: getComputedStyle(host).backgroundColor,
      }
    })
    assert.equal(surfaces.canvas, surfaces.app)

    await saveElementScreenshot('.canvas-preview-card', 'canvas-transparent-background-dark.png')
  })

  it('lets an artefact override the default canvas background', async function () {
    this.timeout(90_000)

    await renderCanvas('Please render the explicit canvas background.', 2)

    await browser.waitUntil(
      async () =>
        browser.execute((title) => {
          const candidate = Array.from(
            document.querySelectorAll<HTMLElement>('.canvas-preview-card'),
          ).find((element) => element.textContent?.includes(title))
          const preview = candidate?.querySelector<HTMLImageElement>('.canvas-preview-image')
          return preview?.complete === true && preview.naturalWidth > 0
        }, OVERRIDE_TITLE),
      { timeout: 20_000, timeoutMsg: 'expected explicit canvas preview image to load' },
    )

    const cards = await $$('.canvas-preview-card')
    const card = cards.at(-1)
    assert.ok(card)
    const image = card.$('.canvas-preview-image')
    const preview = await image.getAttribute('src')
    assert.ok(preview?.startsWith('data:image/png;base64,'))
    assert.deepEqual(await previewCornerPixel(OVERRIDE_TITLE), EXPLICIT_BACKGROUND)
  })
})
