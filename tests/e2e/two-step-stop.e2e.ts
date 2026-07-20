import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('two-step stop shortcut', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('arms on Escape, then stops on a second Escape without submitting another prompt', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-two-step-stop', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()

    const composer = $('.prompt-input')
    await composer.waitForExist({ timeout: 30_000 })
    await setComposerValue('Keep running [[mock:delay_ms 6000]]')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
      timeoutMsg: 'expected a running thread',
    })

    await composer.click()
    await browser.keys('Escape')

    const stopButton = $('.stop-btn')
    await expect(stopButton).toHaveElementClass('stop-pending')
    await saveElementScreenshot('#input-bar', 'two-step-stop-armed.png')

    await browser.keys('Escape')
    await expect(stopButton).not.toHaveElementClass('stop-pending')
    await waitForAgentIdle(15_000)
  })
})
