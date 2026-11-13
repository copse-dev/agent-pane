import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { expectAssistantReply, prepareMockTurn } from './helpers/mock-scenario.ts'
import { saveAppViewportScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { frameInTranscript } from './helpers/sticky-prompt.ts'

let projectRoot = ''

async function checkViewport(width: number, height: number, label: string): Promise<void> {
  const reply = `${label} viewport checked.`
  const scenario = await prepareMockTurn(`Check the ${label.toLowerCase()} layout.`, [
    { toolCalls: [{ name: 'browser_resize', args: { width, height, viewId: 'tab-1' } }] },
    {
      toolCalls: [{ name: 'browser_snapshot', args: { viewId: 'tab-1' } }],
      expectToolResults: [
        { name: 'browser_resize', includes: `${String(width)}×${String(height)}` },
      ],
    },
    {
      toolCalls: [{ name: 'browser_screenshot', args: { viewId: 'tab-1' } }],
      expectToolResults: [{ name: 'browser_snapshot', includes: `${label} layout` }],
    },
    { text: reply, expectToolResults: [{ name: 'browser_screenshot' }] },
  ])
  await $('.submit-btn').click()
  await expectAssistantReply(reply)
  await waitForAgentIdle(20_000)
  await scenario.assertComplete()
  const images = await $$('.tool-result-preview-image').getElements()
  const image = images.at(-1)
  assert.ok(image)
  await image.scrollIntoView()
  await image.waitForDisplayed({ timeout: 15_000 })
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const images = document.querySelectorAll<HTMLImageElement>('.tool-result-preview-image')
        const last = images.item(images.length - 1)
        return last.complete && last.naturalWidth > 0
      }),
    { timeout: 10_000, timeoutMsg: 'viewport screenshot did not decode' },
  )
  const imageSize = await browser.execute(() => {
    const images = document.querySelectorAll<HTMLImageElement>('.tool-result-preview-image')
    const last = images.item(images.length - 1)
    return { width: last.naturalWidth, height: last.naturalHeight }
  })
  assert.ok(imageSize.width > 0 && imageSize.height > 0)
  assert.ok(Math.abs(imageSize.width / imageSize.height - width / height) < 0.005)
  await expect($('#approval-dialog')).not.toBeDisplayed()
  const messageId = await browser.execute(() => {
    const images = document.querySelectorAll<HTMLImageElement>('.tool-result-preview-image')
    return images.item(images.length - 1).closest<HTMLElement>('[data-message-id]')?.dataset[
      'messageId'
    ]
  })
  assert.ok(messageId)
  const framed = await frameInTranscript([
    `[data-message-id=${JSON.stringify(messageId)}] > .tool-result-images`,
  ])
  assert.ok(framed.fits, JSON.stringify(framed))
  await saveAppViewportScreenshot(`browser-responsive-${label.toLowerCase()}.png`)
}

describe('responsive agent browser viewport', () => {
  before(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-responsive-'))
    writeFileSync(
      join(projectRoot, 'index.html'),
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Responsive preview</title><style>body{margin:0;padding:24px;background:#edf5f0;color:#123b30;font:18px system-ui}.mobile{display:none}button{padding:12px} @media(max-width:600px){body{background:#fff0e7}.desktop{display:none}.mobile{display:block}}</style></head><body><h1 class="desktop">Desktop layout</h1><h1 class="mobile">Mobile layout</h1><button onclick="this.textContent=\'Clicked at this size\'">Try this layout</button></body></html>',
    )
    resetUserData()
    seedEmptyProject(projectRoot, 'responsive-browser-project', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const scenario = await prepareMockTurn('Open the responsive application preview.', [
      { toolCalls: [{ name: 'browser_preview', args: {} }] },
      { text: 'Responsive preview opened.', expectToolResults: [{ name: 'browser_preview' }] },
    ])
    await $('.submit-btn').click()
    await expectAssistantReply('Responsive preview opened.')
    await waitForAgentIdle(15_000)
    await scenario.assertComplete()
  })

  after(() => {
    resetUserData()
    if (projectRoot) rmSync(projectRoot, { recursive: true })
  })

  it('renders the mobile layout and restores the desktop layout through the real tool', async () => {
    await checkViewport(390, 844, 'Mobile')
    await checkViewport(1280, 800, 'Desktop')
  })
})
