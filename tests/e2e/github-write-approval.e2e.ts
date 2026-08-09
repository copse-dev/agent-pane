import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('GitHub write approval', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-github-write-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a human question and PR target instead of snake_case + JSON', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('[[mcp:gh_pr_mark_ready {"number":1478}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Mark pull request ready for review?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toBe('PR #1478')
    expect(body).not.toContain('{')
    expect(body).not.toContain('gh_pr_mark_ready')

    await expect(dialog.$('.approval-approve')).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.approval-reject')).toHaveElementClass('ui-btn-secondary')

    await saveElementScreenshot('#approval-dialog', 'github-write-approval-dialog.png')
    await saveAppScreenshot('github-write-approval.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
