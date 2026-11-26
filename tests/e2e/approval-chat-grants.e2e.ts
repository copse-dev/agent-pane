import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  gitPushApproval,
  gitPushChatGrantCopy,
  tempWriteApproval,
} from '../../src/shared/approval-copy.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-approval-chat-grants'

describe('approval prompts with a chat grant', function () {
  this.timeout(30_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('asks to write named /tmp paths inside the sandbox, with a chat grant beside it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 20_000 })
    const command = 'curl -s -c /tmp/rider_cookies.txt http://localhost:3000/api/me'
    // The fields permission-gate's resolveTempWrite sends, with its real copy.
    const request = {
      id: 'temp-write-chat-grant',
      ...tempWriteApproval(command, ['/tmp/rider_cookies.txt']),
      type: 'shell',
      allowRemember: true,
    }
    await browser.execute(async (value) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.emitApprovalRequests([value])
    }, request)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog).toHaveText(expect.stringContaining('Let this command write to /tmp?'))
    const once = dialog.$('.approval-approve-once')
    await expect(once).toHaveText('Allow once')
    await expect(once).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.approval-approve')).toHaveText('Allow for this chat')
    await expect(dialog).toHaveText(
      expect.stringContaining('stays in the project sandbox, with no internet access'),
    )

    await prepareE2eScreenshot()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'approval-temp-write-chat-grant.png'))
    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()
  })

  it('offers Push once and Allow for this chat on a push of the thread branch', async () => {
    const branch = 'copse/restore-the-pink-hero-banner'
    const request = {
      id: 'push-chat-grant',
      ...gitPushApproval(branch),
      ...gitPushChatGrantCopy(branch),
      type: 'mcp',
      allowRemember: true,
    }
    await browser.execute(async (value) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.emitApprovalRequests([value])
    }, request)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog).toHaveText(expect.stringContaining('Push branch to origin?'))
    const once = dialog.$('.approval-approve-once')
    await expect(once).toHaveText('Push once')
    await expect(once).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.approval-approve')).toHaveText('Allow for this chat')
    await expect(dialog).toHaveText(expect.stringContaining('fast-forward only'))

    await prepareE2eScreenshot()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'approval-push-chat-grant.png'))
  })
})
