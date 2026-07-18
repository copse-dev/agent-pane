import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedHeldQueueFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// C2 held-state visual eval (decisions 5 & 16). A hook-originated queued message
// that was held (`autoDispatch: false`) renders in the pinned queue panel with a
// distinct "HELD" badge and a "Release" action instead of the plain queued
// "Send now" — the drain loop skips it, so only an explicit human release submits
// it. Drain-skip + release semantics are unit-tested in
// controller/message-queue.test.ts; the DOM shape in views/queued-held.test.ts.
// This captures the rendered state for visual inspection per AGENTS.md.

describe('held hook message in the queue', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('renders a held badge + Release action and captures a screenshot', async function () {
    resetUserData()
    seedHeldQueueFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const heldItem = await $('.conversation-queued .msg-queued.msg-held')
    await heldItem.waitForExist({ timeout: 10_000 })

    await expect($('.msg-held .message-queued-badge')).toHaveText('HELD')
    await expect($('.msg-held .queued-release')).toBeExisting()
    // A held item is released, not "Send now"-ed like a plain queued message.
    await expect($('.msg-held .queued-send-now')).not.toBeExisting()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-held.png'))
  })
})
