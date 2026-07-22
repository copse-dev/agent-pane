import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import {
  resetUserData,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-ui-kit-confirm'
const CONTROL_KEY = Key.Ctrl

/**
 * Visual eval for the first UI-kit slice: confirm dialog buttons/actions use
 * `.ui-btn*` + `<copse-ui-actions>` instead of screen-local button CSS.
 */
describe('UI kit confirm dialog', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'thread-a',
          title: 'Keep me',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'thread-b',
          title: 'Delete candidate',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('renders kit buttons in the confirm dialog', async function () {
    this.timeout(60_000)

    await browser.action('key').down(CONTROL_KEY).down('w').up('w').up(CONTROL_KEY).perform()

    const dialog = await $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.confirm-dialog-message')).toHaveText('Delete this thread?')
    await expect(await dialog.$('copse-ui-actions.ui-actions')).toExist()
    await expect(await dialog.$('button.ui-btn.ui-btn-secondary.confirm-dialog-cancel')).toHaveText(
      'Cancel',
    )
    await expect(await dialog.$('button.ui-btn.ui-btn-danger.confirm-dialog-confirm')).toHaveText(
      'Delete',
    )

    await saveElementScreenshot('#confirm-dialog', 'ui-kit-confirm-dialog.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
