import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { seedProjectConfig } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOTS = join(process.cwd(), 'test-results', 'skills-screenshots')

describe('skills', () => {
  before(async () => {
    await seedProjectConfig(process.cwd(), {
      projectId: 'skills-demo-project',
      threadId: 'skills-demo-thread',
    })
    await browser.reloadSession()
  })

  it('slash picker and manual invocation', async () => {
    await mkdir(SCREENSHOTS, { recursive: true })

    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const textarea = await $('.prompt-input')
    await textarea.click()
    await setComposerValue('/demo')

    await $('.skill-picker .skill-item-name').waitForExist({ timeout: 10_000 })
    await expect($('.skill-item-name*=/demo-skill')).toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOTS, '01-slash-picker.png'))

    await setComposerValue('/demo-skill validate skills support')
    await browser.saveScreenshot(join(SCREENSHOTS, '02-skill-input.png'))

    await $('.submit-btn').click()
    await $('.msg-user').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.msg-assistant').length)) >= 1,
      { timeout: 20_000 },
    )

    const assistantText = await $('.msg-assistant .message-text')
    await expect(assistantText).toHaveText('Demo skill active — Copse skills support is working.', {
      containing: true,
      wait: 20_000,
    })

    await browser.saveScreenshot(join(SCREENSHOTS, '03-skill-conversation.png'))
  })
})
