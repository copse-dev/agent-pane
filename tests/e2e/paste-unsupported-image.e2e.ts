import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-paste-unsupported-image'
const TOAST_SHOT = 'paste-unsupported-image-toast.png'

/**
 * A photo pasted via macOS Universal Clipboard from an iPhone commonly
 * arrives as HEIC, not PNG/JPEG. Chromium's `<img>` has no HEIC decoder, so
 * the composer must reject it with a clear toast rather than staging a
 * broken attachment chip.
 */
async function pasteImageIntoComposer(name: string, mimeType: string): Promise<void> {
  await browser.execute(
    (fileName: string, type: string) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array([0, 1, 2, 3])], fileName, { type }))
      document.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      )
    },
    name,
    mimeType,
  )
}

describe('Pasting an unsupported image format', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-paste-unsupported-image-'))
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows an error toast instead of staging a broken chip', async () => {
    const newThreadBtn = $('.project-new-thread-btn')
    await newThreadBtn.waitForClickable({ timeout: 15_000 })
    await newThreadBtn.click()
    await $('.prompt-input').waitForExist({ timeout: 10_000 })

    await pasteImageIntoComposer('photo.heic', 'image/heic')

    const toast = $('.toast-error')
    await toast.waitForDisplayed({ timeout: 5_000 })
    assert.match(await toast.getText(), /format isn't supported/)
    await saveAppScreenshot(TOAST_SHOT)

    assert.equal((await $$('.attachment-chips .image-chip')).length, 0)
  })

  it('still accepts a supported format on the same composer', async () => {
    await browser.execute(() => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        ),
        (char) => char.charCodeAt(0),
      )
      const transfer = new DataTransfer()
      transfer.items.add(new File([png], 'photo.png', { type: 'image/png' }))
      document.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      )
    })

    await expect($('.attachment-chips .image-chip')).toBeDisplayed()
  })
})
