import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// A command that only reads outside the project asks the read-access question
// instead of the generic "Run outside sandbox?" escape hatch: the decision leads,
// the command sits behind "Show details", and expanding it reveals the narrower
// "Approve this command" answer next to the thread-wide Approve.
describe('read access outside the project approval', () => {
  before(async () => {
    resetUserData()
    // First-send checkout must use real local refs, independent of the CI source checkout.
    seedEmptyProject(seedStableWorkspace(), 'e2e-read-outside-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('collapses the command and offers a per-command answer on expand', async () => {
    await prepareMockToolTurn(
      'List the files in my Copse profile.',
      { name: 'run_shell', args: { command: 'ls -la ~/.copse' } },
      'The profile directory listing was declined.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Read outside the project?')
    await expect(dialog.$('.approval-advice')).toHaveText('The agent wants to read ~/.copse.')

    // Collapsed: the command is in the DOM but not shown, and the per-command
    // button waits for the details it refers to.
    expect(await dialog.$('.approval-body').isDisplayed()).toBe(false)
    expect(await dialog.$('.approval-approve-once').isDisplayed()).toBe(false)
    await saveAppScreenshot('read-outside-approval-collapsed.png')

    await dialog.$('.approval-details-toggle').click()
    expect(await dialog.$('.approval-body').getText()).toContain('ls -la ~/.copse')
    const approveOnce = dialog.$('.approval-approve-once')
    await approveOnce.waitForDisplayed({ timeout: 5_000 })
    await expect(approveOnce).toHaveText('Approve this command')
    await saveAppScreenshot('read-outside-approval-expanded.png')

    await dialog.$('.approval-reject').click()
  })
})
