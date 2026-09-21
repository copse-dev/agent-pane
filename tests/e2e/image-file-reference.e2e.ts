import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedImageFileReferenceFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_WORKSPACE_PREFIX = 'copse-image-file-reference-'
const SHOT = 'image-file-reference-lightbox.png'

/**
 * Regression coverage for #2500: an image the agent referenced by plain-text
 * path in a message (not a pasted attachment) must open the shared image
 * lightbox on click, not the text/Monaco file viewer.
 */
describe('Image file reference click-to-expand', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), PROJECT_WORKSPACE_PREFIX))
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedImageFileReferenceFixture(workspaceRoot)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('opens the image lightbox instead of the file viewer', async () => {
    const link = $('a.file-reference-link')
    await link.waitForDisplayed({ timeout: 15_000 })
    assert.equal(await link.getText(), 'screenshot.png')

    await link.click()

    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForExist({ timeout: 5_000 })
    assert.equal(await dialog.getAttribute('data-preview-kind'), 'image')
    const expandedSrc = await $('.image-expand-image').getAttribute('src')
    assert.ok(
      typeof expandedSrc === 'string' && expandedSrc.startsWith('data:image/png;base64,'),
      'lightbox shows the image as a data URL, not raw/garbled bytes',
    )

    // The text/Monaco file viewer never opens for an image reference.
    await expect($('.monaco-container')).not.toBeDisplayed()

    await saveAppScreenshot(SHOT)
    await $('.attachment-preview-close').click()
  })
})
