import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

// Keep mutating GitHub approval in the runtime gate; #1680 records the former
// quarantine and the evidence required for reinstatement.
describe('GitHub write approval', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-github-write-approval-project', {
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

    await prepareMockToolTurn(
      'Mark pull request 1478 ready for review.',
      { name: 'gh_pr_mark_ready', args: { number: 1478 } },
      'The readiness request was declined; the pull request remains unchanged.',
    )
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
    await waitForAgentIdle()
  })

  it('prompts before gh_pr_create opens a pull request, showing the PR title', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await prepareMockToolTurn(
      'Create a pull request titled Fix the parser.',
      { name: 'gh_pr_create', args: { title: 'Fix the parser' } },
      'The pull request request was declined; no pull request was created.',
    )
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Open pull request on GitHub?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toBe('Push the current branch, then open “Fix the parser”.')
    expect(body).not.toContain('gh_pr_create')

    await saveElementScreenshot('#approval-dialog', 'github-write-approval-create-dialog.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle()
  })
})
