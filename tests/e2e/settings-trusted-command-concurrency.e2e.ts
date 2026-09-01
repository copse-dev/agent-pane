import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('concurrent trusted command approvals', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-trusted-command-concurrency')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps every command when remembers overlap', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const remembered = await browser.execute(async () => {
      const bridge = (
        window as unknown as {
          __copseE2e?: {
            rememberTrustedCommands: (commands: string[]) => Promise<unknown>
          }
        }
      ).__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      return bridge.rememberTrustedCommands(['curl', 'xcodebuild'])
    })
    assert.deepEqual(remembered, ['curl', 'xcodebuild'])

    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="permissions"]').click()
    const commands = dialog.$('textarea[name="trustedShellCommands"]')
    await expect(commands).toHaveValue('curl\nxcodebuild')

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('textarea[name="trustedShellCommands"]')
        ?.closest('label')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(100)

    await saveElementScreenshot(
      'label:has(textarea[name="trustedShellCommands"])',
      'settings-concurrent-trusted-commands.png',
    )
  })
})
