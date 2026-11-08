import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

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

    await expect(dialog.$('.approval-heading')).toHaveText(
      'Allow read access outside of the project?',
    )
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('~/.copse')
    const grantedPaths = await dialog.$$('.approval-reasons li')
    expect(grantedPaths).toHaveLength(1)
    await expect(grantedPaths[0]).toHaveText('~/.copse')
    expect(advice).toContain('A listed directory can contain sensitive files')
    const footer = await dialog.$('.approval-footer').getText()
    expect(footer).toContain('Other paths ask again')

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

  it('asks again when a linked directory precedes a parent segment', async function () {
    this.timeout(90_000)
    const root = mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'copse-e2e-read-link-'),
    )
    try {
      const granted = join(root, 'granted')
      mkdirSync(granted)
      const outside = join(root, 'outside')
      const sub = join(outside, 'sub')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(outside, 'note.txt'), 'outside the granted directory')
      symlinkSync(sub, join(granted, 'link'))
      const rawPath = `${granted}/link/../note.txt`

      await prepareMockToolTurn(
        'List this notes directory.',
        { name: 'run_shell', args: { command: `ls -la ${granted}` } },
        'The notes directory was listed.',
      )
      await submitComposer()
      const dialog = $('#approval-dialog')
      await dialog.waitForDisplayed({ timeout: 30_000 })
      await expect(dialog.$('.approval-heading')).toHaveText(
        'Allow read access outside of the project?',
      )
      await dialog.$('.approval-approve').click()
      await expectAssistantReply('The notes directory was listed.')

      await prepareMockToolTurn(
        'Read the linked note.',
        { name: 'run_shell', args: { command: `cat ${rawPath}` } },
        'The traversal read was declined.',
      )
      await submitComposer()
      await dialog.waitForDisplayed({ timeout: 30_000 })
      await expect(dialog.$('.approval-heading')).not.toHaveText(
        'Allow read access outside of the project?',
      )
      await expect(dialog).toHaveText(expect.stringContaining(rawPath))
      await saveElementScreenshot(
        '#approval-dialog .approval-heading',
        'read-outside-parent-traversal-reprompt.png',
      )
      await dialog.$('.approval-reject').click()
      await expectAssistantReply('The traversal read was declined.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
