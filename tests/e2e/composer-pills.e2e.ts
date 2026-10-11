import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('composer pills in light theme', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const repoRoot = seedStableWorkspace()
    writeFileSync(join(repoRoot, 'pills-demo.txt'), 'Example change\n')
    seedEmptyProject(repoRoot, 'e2e-composer-pills-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      mockFollowUps: true,
      reviewEnabled: true,
      theme: 'light',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows Changes and Review changes above the follow-up input', async () => {
    const prompt = 'Review my uncommitted changes and suggest any improvements.'
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    const scenario = await installMockScenario({
      title: 'Review uncommitted changes',
      turns: [{ user: prompt, responses: [{ text: 'Run the relevant tests before merging.' }] }],
    })
    await setComposerValue(prompt)
    await $('.submit-btn').click()
    await $('.composer-dirty-warning').waitForDisplayed({ timeout: 15_000 })
    await $('.composer-dirty-send-btn').click()
    await $('.msg-user').waitForDisplayed({ timeout: 15_000 })
    await $('.msg-assistant .message-text').waitForDisplayed({ timeout: 20_000 })
    await waitForAgentIdle(20_000)
    await $('.follow-up-bubble').waitForDisplayed({ timeout: 30_000 })
    await expect($('html')).toHaveAttribute('data-theme', 'light')
    await expect($('.follow-up-bubble-changes')).toBeDisplayed()
    await expect($('.follow-up-bubble[data-id="review-changes"]')).toHaveText('Review changes')
    await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')

    await saveAppScreenshot('composer-pills-light.png')
    await scenario.assertComplete()
  })
})
