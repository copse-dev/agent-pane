import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Must match mockNextStepHint() in src/main/services/next-step-service.ts.
const MOCK_HINT = 'Run the test suite to verify the fix'

describe('next-step tab complete (experimental)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-next-step-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      mockNextStep: true,
      nextStepSuggestionEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('offers the hint as placeholder after a turn and inserts it on Tab', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('fix the bug')
    await $('.submit-btn').click()
    await waitForAgentIdle(20_000)

    // The hint rides in the placeholder slot, marked for the Tab keycap CSS.
    await browser.waitUntil(
      async () => (await $('.prompt-input').getAttribute('data-placeholder')) === MOCK_HINT,
      { timeout: 30_000, timeoutMsg: 'next-step hint never reached the placeholder' },
    )
    await expect($('.prompt-input')).toHaveAttribute('data-next-step')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'next-step-hint.png'))

    // Tab accepts: the hint becomes composer text and the offer is spent.
    await $('.prompt-input').click()
    await browser.keys('Tab')
    await expect($('.prompt-input')).toHaveText(MOCK_HINT)
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Message…')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'next-step-hint-accepted.png'))
  })
})
