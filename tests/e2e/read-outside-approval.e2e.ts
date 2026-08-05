import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// A command that only reads outside the project asks the read-access question
// instead of the generic "Run outside sandbox?" escape hatch: the decision leads,
// the command sits behind "Show details", and expanding it reveals the narrower
// "Approve this command" answer next to the thread-wide Approve.
describe('read access outside the project approval', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-read-outside-project', {
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
    await setComposerValue('[[mcp:run_shell {"command":"ls -la ~/.copse"}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText(
      'Allow read access outside of the project?',
    )
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('~/.copse')
    expect(advice).toContain('read from sensitive locations on your computer')

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
