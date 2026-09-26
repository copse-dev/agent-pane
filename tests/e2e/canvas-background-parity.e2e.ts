import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { PNG } from 'pngjs'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveAppScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'

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
  }
</style>
`

// The local mock provider renders through MCP; inline visualization control
// frames are handled by the ACP executor only.

/** WCAG relative luminance of a computed `rgb()`/`rgba()` colour. */
function luminance(color: string): number {
  const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  assert.equal(channels.length, 3, `expected a computed colour, got ${color}`)
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/**
 * The probe's text colour inside the active canvas guest, alongside the host
 * surface it sits on. The fixtures declare no text colour of their own.
 */
async function activeGuestText(): Promise<{ guest: string | null; host: string; hostBg: string }> {
  return browser.execute(async () => {
    const host = document.querySelector<HTMLElement>(
      '.browser-tab-panel.is-active .browser-webview-host',
    )
    const webview = host?.querySelector('webview') as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    const guest = await webview
      ?.executeJavaScript?.(
        'getComputedStyle(document.getElementById("canvas-background-probe") ?? document.body).color',
      )
      .catch(() => null)
    const hostStyle = host ? getComputedStyle(host) : null
    return {
      guest: typeof guest === 'string' ? guest : null,
      host: hostStyle?.color ?? '',
      hostBg: hostStyle?.backgroundColor ?? '',
    }
  })
}

/** Brightest pixel in the preview thumbnail: text on the theme surface. */
async function previewMaxLuminance(title: string): Promise<number> {
  return browser.execute((expectedTitle) => {
    const card = Array.from(document.querySelectorAll('.canvas-preview-card')).find(
      (candidate) =>
        candidate.querySelector('.canvas-preview-title')?.textContent === expectedTitle,
    )
    const image = card?.querySelector<HTMLImageElement>('.canvas-preview-image')
    if (!image?.complete || !image.naturalWidth) throw new Error('canvas preview is not ready')
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable')
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let max = 0
    for (let index = 0; index < data.length; index += 4) {
      const value =
        0.2126 * (data[index] ?? 0) +
        0.7152 * (data[index + 1] ?? 0) +
        0.0722 * (data[index + 2] ?? 0)
      if (value > max) max = value
    }
    return max
  }, title)
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
  const explicit = prompt.includes('explicit')
  const scenario = await prepareMockToolTurn(
    prompt,
    {
      name: CANVAS_TOOL,
      args: {
        title: explicit ? OVERRIDE_TITLE : TITLE,
        html: explicit ? OVERRIDDEN_ARTEFACT : TRANSPARENT_ARTEFACT,
      },
    },
    'The canvas preview is ready.',
  )
  await submitComposer()
  await browser.waitUntil(
    async () =>
      browser.execute((count) => {
        const completedReplies = Array.from(
          document.querySelectorAll('.msg-assistant > .message-body > .message-text'),
        ).filter((message) => message.textContent?.includes('The canvas preview is ready.')).length
        return (
          document.querySelectorAll('.tool-card[data-tool-id][data-status="done"]').length ===
            count && completedReplies >= count
        )
      }, expectedToolCount),
    { timeout: 30_000, timeoutMsg: 'expected the canvas render turn to finish' },
  )
  await waitForAgentIdle(30_000)
  await scenario.assertComplete()
  // The final reply replaces the running transcript and restores the rollup's
  // collapsed state. Wait for that repaint above, then open the completed tool;
  // otherwise the preview can disappear between its pixel check and capture.
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

async function saveCanvasPreviewScreenshot(filename: string, title: string): Promise<void> {
  // The fixed-size preparation dispatches a resize, which rebuilds the transcript
  // and restores completed rollups to their collapsed state. Prepare first, then
  // reveal the preview in the final layout that will actually be captured.
  await prepareE2eScreenshot()
  // Flipping `details.open` directly records no preference, so a rebuild that
  // lands after the visibility check (seen on Electron 44.3 / Chromium
  // 152.0.7977.78) collapses the rollup again and chromedriver measures a 0x0
  // card. Open the rollup through its real summary handler, which records the
  // choice, and do the same for any other collapsed ancestor.
  await pinPreviewRollupOpen(title)
  await browser.waitUntil(
    async () =>
      browser.execute((expectedTitle) => {
        const card = Array.from(
          document.querySelectorAll<HTMLElement>('.canvas-preview-card'),
        ).find(
          (candidate) =>
            candidate.querySelector('.canvas-preview-title')?.textContent === expectedTitle,
        )
        if (!card) return false
        for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
            ancestor.querySelector<HTMLElement>(':scope > summary')?.click()
            return false
          }
        }
        card.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = card.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }, title),
    { timeout: 15_000, timeoutMsg: 'expected the expanded canvas preview to be visible' },
  )
  await waitForSettledLayout('.canvas-preview-card')
  const crop = await browser.execute(() => {
    const card = document.querySelector<HTMLElement>('.canvas-preview-card')
    if (!card) throw new Error('canvas preview card missing before capture')
    const rect = card.getBoundingClientRect()
    const scale = window.devicePixelRatio
    const left = Math.floor(rect.left * scale)
    const top = Math.floor(rect.top * scale)
    const right = Math.ceil(rect.right * scale)
    const bottom = Math.ceil(rect.bottom * scale)
    return { left, top, width: right - left, height: bottom - top }
  })
  const viewport = PNG.sync.read(Buffer.from(await browser.takeScreenshot(), 'base64'))
  assert.ok(crop.left >= 0 && crop.top >= 0, 'canvas preview starts outside the viewport')
  assert.ok(crop.width > 0 && crop.height > 0, 'canvas preview has no capture area')
  assert.ok(
    crop.left + crop.width <= viewport.width && crop.top + crop.height <= viewport.height,
    'canvas preview extends outside the viewport',
  )
  const preview = new PNG({ width: crop.width, height: crop.height })
  PNG.bitblt(viewport, preview, crop.left, crop.top, crop.width, crop.height, 0, 0)
  await writeFile(join(E2E_SCREENSHOT_DIR, filename), PNG.sync.write(preview))
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
    resetUserData()
  })

  it('matches a transparent preview to the live dark canvas', async function () {
    this.timeout(90_000)
    await waitForPromptReady()

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
    // The headless mirror gives the transparent document the host text colour
    // too, so the thumbnail shows light text rather than black on dark.
    expect(await previewMaxLuminance(TITLE)).toBeGreaterThan(150)
    await saveCanvasPreviewScreenshot('canvas-transparent-background-dark.png', TITLE)

    await browser.execute((title) => {
      const candidate = Array.from(
        document.querySelectorAll<HTMLElement>('.canvas-preview-card'),
      ).find((element) => element.querySelector('.canvas-preview-title')?.textContent === title)
      const openButton = candidate?.querySelector<HTMLButtonElement>('button')
      if (!openButton) throw new Error(`Open button missing for canvas ${title}`)
      openButton.click()
    }, TITLE)
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

    // Host CSS does not inherit into the guest: the transparent artefact takes
    // the injected host text colour instead of Chromium's default black.
    let text = await activeGuestText()
    await browser.waitUntil(
      async () => {
        text = await activeGuestText()
        return text.guest !== null && text.guest === text.host
      },
      { timeout: 15_000, timeoutMsg: 'expected the canvas guest to take the host text colour' },
    )
    expect(contrastRatio(text.guest ?? '', text.hostBg)).toBeGreaterThan(7)
    await saveAppScreenshot('canvas-transparent-text-dark.png')
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

    // An artefact that paints its own background keeps the browser's default
    // text colour: the host colour is only for the surface the host supplies.
    await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(async () => (await activeGuestText()).guest !== null, {
      timeout: 15_000,
      timeoutMsg: 'expected the explicit-background canvas to load in the Browser pane',
    })
    expect((await activeGuestText()).guest).toBe('rgb(0, 0, 0)')
  })
})
