import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMessageImageFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_WORKSPACE_PREFIX = 'copse-image-expand-'
const THREAD_SHOT = 'image-expand-thread.png'
const THREAD_DISMISSED_SHOT = 'image-expand-thread-dismissed.png'
const TEXT_SHOT = 'attachment-preview-text.png'
const ROADMAP_SHOT = 'image-expand-roadmap.png'

/** 64×40 teal checker PNG so the modal has visible content for visual review. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAYAAABOzvzpAAAA0ElEQVR4AeXBQVUFUAxDwUvO14GISniqKqELRKCkEmoJHMRAZr6+f37/MPYG51Xj7A3Oq8bZG5xXjbM3OCKcCCfCiXAinAgnwn32BudV4+wNzqvG2RucV42zNzivGkeEE+FEOBFOhBPhRLjPq8bZG5xXjbM3OK8aZ29wXjXO3uCIcCKcCCfCiXAinAj32RucV42zNzivGmdvcF41zt7gvGocEU6EE+FEOBFOhBPhPq8aZ29wXjXO3uC8apy9wXnVOHuDI8KJcCKcCCfCiXAi3D+9RD21GVAxSwAAAABJRU5ErkJggg=='
const IMAGE_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/** Deliver files to the roadmap form the way Chromium delivers a paste of OS files. */
async function pasteFilesIntoForm(
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await browser.execute((specs) => {
    const form = document.querySelector('.roadmap-form')
    if (!form) throw new Error('roadmap form not mounted')
    const transfer = new DataTransfer()
    for (const spec of specs) {
      const bytes = Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0))
      transfer.items.add(new File([bytes], spec.name, { type: spec.type }))
    }
    form.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, files)
}

describe('Screenshot click-to-expand', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), PROJECT_WORKSPACE_PREFIX))
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMessageImageFixture(workspaceRoot, IMAGE_DATA_URL, { roadmapPlansEnabled: true })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('expands a thread-panel attachment in a modal', async () => {
    const thumb = $('.message-image.image-expandable')
    await thumb.waitForDisplayed({ timeout: 15_000 })
    assert.equal(await thumb.getAttribute('role'), 'button')
    assert.equal(await thumb.getAttribute('aria-label'), 'Expand Attached image')

    await thumb.click()
    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForExist({ timeout: 5_000 })
    await expect($('.image-expand-image')).toExist()
    const expandedSrc = await $('.image-expand-image').getAttribute('src')
    assert.ok(
      typeof expandedSrc === 'string' && expandedSrc.startsWith('data:image/png;base64,'),
      'modal shows the attachment data URL',
    )

    await saveAppScreenshot(THREAD_SHOT)

    await $('.attachment-preview-close').click()
    const closed = $('dialog.attachment-preview-dialog')
    await browser.waitUntil(
      async () => {
        if (!(await closed.isExisting())) return true
        const open = await closed.getAttribute('open')
        if (open != null) return false
        // Author `display: flex` used to outrank UA closed-dialog hiding and leave
        // a ghost modal (broken-image alt + Close). Assert it is actually gone.
        return !(await closed.isDisplayed())
      },
      {
        timeout: 5_000,
        timeoutMsg: 'expected the image expand dialog to close and leave the page',
      },
    )
    await expect(closed).not.toBeDisplayed()
    await saveAppScreenshot(THREAD_DISMISSED_SHOT)
  })

  it('previews a sent text file in the same modal shell', async () => {
    const chip = $('.transcript-attachment-file.text-expandable')
    await chip.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await chip.getAttribute('role'), 'button')
    assert.equal(await chip.getAttribute('aria-label'), 'Preview running-tests.diff')

    await chip.click()
    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForExist({ timeout: 5_000 })
    assert.equal(await dialog.getAttribute('data-preview-kind'), 'text')
    await expect($('.attachment-preview-title')).toHaveText('running-tests.diff')
    await expect($('.attachment-preview-text')).toHaveText(
      expect.stringContaining('+ expect(status).toBe("running")'),
    )
    await saveAppScreenshot(TEXT_SHOT)
    await $('.attachment-preview-close').click()
  })

  it('expands a roadmap plan attachment thumb in the same modal', async () => {
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    await $('.roadmap-prompt-input').setValue('Inspect this screenshot from the plan')
    await pasteFilesIntoForm([{ name: 'plan-shot.png', type: 'image/png', base64: PNG_BASE64 }])

    await browser.waitUntil(async () => (await $$('.roadmap-attachment-thumb')).length === 1, {
      timeout: 5_000,
      timeoutMsg: 'expected the pasted plan screenshot to stage as a thumb',
    })

    const thumb = $('.roadmap-attachment-thumb.image-expandable')
    await thumb.waitForDisplayed({ timeout: 5_000 })
    await thumb.click()

    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForExist({ timeout: 5_000 })
    const expandedSrc = await $('.image-expand-image').getAttribute('src')
    assert.ok(
      typeof expandedSrc === 'string' && expandedSrc.startsWith('data:image/png;base64,'),
      'plan modal shows the chip data URL',
    )
    await expect($('.attachment-preview-close')).toExist()
    await saveAppScreenshot(ROADMAP_SHOT)
  })
})
