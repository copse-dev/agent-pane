import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { PNG } from 'pngjs'
import type { MockScriptStep } from '../../src/shared/llm/mock-script.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveThreePaneScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-canvas-background-parity'
const TITLE = 'Transparent canvas parity'
const OVERRIDE_TITLE = 'Explicit canvas background'
const FIXTURE_PATH = join(process.cwd(), '.tmp', 'canvas-transparent-background.html')
const OVERRIDE_FIXTURE_PATH = join(process.cwd(), '.tmp', 'canvas-explicit-background.html')
const REFERENCE =
  '\u{e200}visualize\u{e202}' +
  JSON.stringify({ path: FIXTURE_PATH, title: TITLE, mode: 'wide' }) +
  '\u{e201}'
const OVERRIDE_REFERENCE =
  '\u{e200}visualize\u{e202}' +
  JSON.stringify({ path: OVERRIDE_FIXTURE_PATH, title: OVERRIDE_TITLE, mode: 'wide' }) +
  '\u{e201}'
const SCRIPT = [
  {
    when: 'render the transparent canvas',
    text: REFERENCE,
  },
  {
    when: 'render the explicit canvas background',
    text: OVERRIDE_REFERENCE,
  },
] satisfies MockScriptStep[]

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

describe('canvas background parity', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''

    mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
    writeFileSync(FIXTURE_PATH, TRANSPARENT_ARTEFACT)
    writeFileSync(OVERRIDE_FIXTURE_PATH, OVERRIDDEN_ARTEFACT)
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      model: 'claude-sonnet-4-6',
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
    rmSync(FIXTURE_PATH, { force: true })
    rmSync(OVERRIDE_FIXTURE_PATH, { force: true })
  })

  it('matches a transparent preview to the live dark canvas', async function () {
    this.timeout(90_000)
    await waitForPromptReady()
    await installMockScript()

    await setComposerValue('Please render the transparent canvas.')
    await $('.submit-btn').click()
    await waitForAgentIdle(45_000)

    const card = $('.message-canvas-previews .canvas-preview-card')
    await card.waitForExist({ timeout: 20_000 })
    const image = card.$('.canvas-preview-image')
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const candidate = document.querySelector<HTMLImageElement>(selector)
          return candidate?.complete === true && candidate.naturalWidth > 0
        }, '.message-canvas-previews .canvas-preview-image'),
      { timeout: 20_000, timeoutMsg: 'expected canvas preview image to load' },
    )

    const preview = await image.getAttribute('src')
    assert.ok(preview?.startsWith('data:image/png;base64,'))
    const comma = preview.indexOf(',')
    assert.ok(comma >= 0)
    const png = PNG.sync.read(Buffer.from(preview.slice(comma + 1), 'base64'))
    const previewCorner = Array.from(png.data.subarray(0, 4))
    const themePixel = await resolvedBodyBackgroundPixel()
    assert.deepEqual(previewCorner, themePixel)

    await card.$('button').click()
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

    await browser.execute(() => {
      document
        .querySelector('.message-canvas-previews .canvas-preview-card')
        ?.scrollIntoView({ block: 'center' })
    })
    await saveThreePaneScreenshot('canvas-transparent-background-dark.png', {
      filesPaneWidth: 600,
    })
  })

  it('lets an artefact override the default canvas background', async function () {
    this.timeout(90_000)

    await setComposerValue('Please render the explicit canvas background.')
    await $('.submit-btn').click()
    await waitForAgentIdle(45_000)

    const cards = await $$('.message-canvas-previews .canvas-preview-card')
    const card = cards.at(-1)
    assert.ok(card)
    await card.waitForExist({ timeout: 20_000 })
    const image = card.$('.canvas-preview-image')
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

    const preview = await image.getAttribute('src')
    assert.ok(preview?.startsWith('data:image/png;base64,'))
    const comma = preview.indexOf(',')
    assert.ok(comma >= 0)
    const png = PNG.sync.read(Buffer.from(preview.slice(comma + 1), 'base64'))
    assert.deepEqual(Array.from(png.data.subarray(0, 4)), EXPLICIT_BACKGROUND)
  })
})
