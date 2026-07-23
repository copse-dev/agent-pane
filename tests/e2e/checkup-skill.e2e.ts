import { $, browser, expect } from '@wdio/globals'
import { seedProjectConfig } from './helpers.ts'
import { assertNoErrorToasts, collectErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('checkup skill', () => {
  before(async () => {
    // seedProjectConfig only writes config.json — reset settings so a stale
    // onboardingCompleted:false (or missing settings) cannot leave the wizard
    // overlay intercepting the composer submit click.
    resetUserData()
    await seedProjectConfig(process.cwd(), {
      projectId: 'checkup-skill-project',
      threadId: 'checkup-skill-thread',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('picks /checkup from the slash picker and runs without Unknown skill', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Type the full skill name so workspace skills that only share a looser
    // "check" substring (name/description) cannot outrank `/checkup` at idx 0.
    await setComposerValue('/checkup')
    const picker = $('.skill-picker')
    await picker.waitForDisplayed({ timeout: 10_000 })
    const checkupRow = picker.$('.skill-item*=/checkup')
    await checkupRow.waitForExist({ timeout: 5_000 })
    await expect(checkupRow.$('.skill-item-name')).toHaveText('/checkup')

    // Enter inserts `/checkup ` for the highlighted (only) match and closes.
    await browser.keys('Enter')
    await browser.waitUntil(async () => !(await picker.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'skill picker should close after picking /checkup',
    })

    await $('.submit-btn').click()

    // The regression: stale skillsCache treated `/checkup` as unknown even
    // though the picker had just shown it.
    await browser.waitUntil(
      async () => {
        const toasts = await collectErrorToasts()
        return !toasts.some((t) => t.includes('Unknown skill'))
      },
      { timeout: 5_000, timeoutMsg: 'Unknown skill toast must not appear for /checkup' },
    )

    await $('.msg-user').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.msg-assistant').length)) >= 1,
      { timeout: 30_000 },
    )

    // Prefer the live checkup tool card when the mock steers `run_checkup`;
    // fall back to the mock's checkup confirmation text.
    const toolName = await browser.execute(() => {
      const el = document.querySelector('.tool-card .tool-name, .tool-card-group .tool-name')
      return el?.textContent?.trim() ?? ''
    })
    if (toolName) {
      await expect(toolName).toMatch(/checkup/i)
    } else {
      const assistantText = await $('.msg-assistant .message-text')
      await expect(assistantText).toHaveText('Ran a checkup', { containing: true, wait: 20_000 })
    }

    await assertNoErrorToasts('after /checkup')
    await saveAppScreenshot('checkup-skill-picked.png')
  })
})
