import { readFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('skills', () => {
  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace({
      files: {
        '.cursor/skills/demo-skill/SKILL.md': readFileSync(
          new URL('../../.cursor/skills/demo-skill/SKILL.md', import.meta.url),
          'utf8',
        ),
      },
    })
    seedEmptyProject(workspaceRoot, 'skills-demo-project', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('invokes a workspace skill through the live agent path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // The composer mounts before the workspace's background skill scan completes.
    await browser.waitUntil(
      async () =>
        browser.execute(async () =>
          (await window.api.skills.list()).some((skill) => skill.name === 'demo-skill'),
        ),
      { timeout: 10_000, timeoutMsg: 'workspace demo skill was not discovered' },
    )
    await setComposerValue('/demo-skill')
    const skill = $('.skill-picker').$('.skill-item*=/demo-skill')
    await skill.waitForDisplayed({ timeout: 10_000 })
    await expect(skill.$('.skill-item-name')).toHaveText('/demo-skill')

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
    await waitForAgentIdle()
    await waitForActiveThreadTitle()
    await assertNoErrorToasts('after /demo-skill')
    await saveAppScreenshot('skills-demo-invoked.png')
  })
})
