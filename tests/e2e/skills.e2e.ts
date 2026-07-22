import { $, browser, expect } from '@wdio/globals'
import { seedProjectConfig } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'

describe('skills', () => {
  before(async () => {
    await seedProjectConfig(process.cwd(), {
      projectId: 'skills-demo-project',
      threadId: 'skills-demo-thread',
    })
    await browser.reloadSession()
  })

  it('invokes a workspace skill through the live agent path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('/demo-skill validate skills support')
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
  })
})
