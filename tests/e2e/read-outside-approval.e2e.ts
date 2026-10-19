import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn, prepareMockTurn } from './helpers/mock-scenario.ts'
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

    const dialog = await $('#approval-dialog')
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

  it('approves an external file read and reuses only that path for search', async function () {
    if (process.platform === 'win32') this.skip()
    // /etc/hosts is a non-credential, stable external file on both supported
    // sandbox platforms. Assert the actual tool result, not the mock reply.
    const scenario = await prepareMockTurn('Read the hosts file, then find localhost in it.', [
      { toolCalls: [{ name: 'read_file', args: { path: '/etc/hosts' } }] },
      {
        expectToolResults: [{ name: 'read_file', includes: 'localhost' }],
        toolCalls: [
          {
            name: 'search_code',
            args: { path: '/etc/hosts', pattern: 'localhost', fixed_string: true },
          },
        ],
      },
      {
        text: 'The approved hosts file contains localhost.',
        expectToolResults: [{ name: 'search_code', includes: 'localhost' }],
      },
    ])
    await submitComposer()
    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(
      'Allow read access outside of the project?',
    )
    expect(await dialog.$('.approval-advice').getText()).toContain('/etc/hosts')
    await dialog.$('.approval-details-toggle').click()
    await expect(dialog.$('.approval-approve-once')).toHaveText('Approve this read')
    expect(await dialog.$('.approval-body').getText()).toContain('read_file: /etc/hosts')
    await saveAppScreenshot('external-file-read-approval.png')
    await dialog.$('.approval-approve').click()
    await scenario.waitForComplete()
    await scenario.assertComplete()
  })
})
