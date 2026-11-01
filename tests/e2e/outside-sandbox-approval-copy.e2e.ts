import { $, browser, expect } from '@wdio/globals'
import {
  expectAssistantReply,
  prepareMockToolTurn,
  prepareMockTurn,
} from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { submitComposer } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-outside-sandbox-approval-copy'

describe('outside-sandbox approval copy', () => {
  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace({
      files: { 'audit-ui.mjs': 'console.log(process.argv[2])\n' },
    })
    seedEmptyProject(workspace, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps advice separate while exposing the complete long command', async () => {
    const command = [
      'set -o pipefail',
      ...Array.from(
        { length: 18 },
        (_, index) =>
          `gh pr create --draft --title "Visual approval ${String(index + 1)}" --body "Review item ${String(index + 1)}"`,
      ),
      'printf "final command remains visible\\n"',
    ].join('\n')
    const scenario = await prepareMockToolTurn(
      'Prepare the draft pull requests.',
      {
        name: 'run_shell',
        args: { command, expects_sandbox_block: true },
      },
      'I left the draft pull requests unchanged.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Agent requests sandbox escape')

    const advice = dialog.$('.approval-advice')
    await expect(advice).toHaveText(expect.stringContaining('expects the project sandbox to block'))
    await expect(advice).toHaveText(expect.stringContaining('asking to run outside the sandbox'))

    const body = dialog.$('.approval-body')
    expect(await body.getText()).toBe(command)
    const commandRegion = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('#approval-dialog .approval-body')
      if (!element) throw new Error('approval command region is missing')
      return {
        scrolls: element.scrollHeight > element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }
    })
    expect(commandRegion).toEqual({ scrolls: true, overflowY: 'auto' })
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining("agent's expectation, not a confirmed sandbox block"),
    )

    await saveElementScreenshot('#approval-dialog', 'outside-sandbox-long-command-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I left the draft pull requests unchanged.')
    await scenario.assertComplete()
  })

  it('offers bounded retries when the agent expects a project script to need the outside', async () => {
    // A browser demo rerun after each fix: opaque local execution, nothing else.
    const command = `node audit-ui.mjs 'Array.from(document.querySelectorAll("dialog"))'`
    const scenario = await prepareMockTurn('Run both browser inspections outside the sandbox.', [
      { toolCalls: [{ name: 'run_shell', args: { command, expects_sandbox_block: true } }] },
      {
        expectToolResults: [{ name: 'run_shell' }],
        toolCalls: [
          {
            name: 'run_shell',
            args: {
              command: `node audit-ui.mjs 'Array.from(document.querySelectorAll("iframe"))'`,
              expects_sandbox_block: true,
            },
          },
        ],
      },
      { text: 'I ran both inspections.', expectToolResults: [{ name: 'run_shell' }] },
    ])
    await submitComposer()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Agent requests sandbox escape')
    const leaseOption = dialog.$('.approval-turn-tree')
    await expect(leaseOption).toBeDisplayed()
    await expect(leaseOption).toHaveText(
      'Allow this script with different arguments outside the sandbox for this task (up to 10 runs, for 2 hours)',
    )
    // Opt-in: leaving the sandbox again is never the default.
    await expect(leaseOption.$('.approval-turn-tree-input')).not.toBeChecked()

    await leaseOption.$('.approval-turn-tree-input').click()
    await expect(leaseOption.$('.approval-turn-tree-input')).toBeChecked()
    await saveElementScreenshot('#approval-dialog', 'agent-escape-retry-lease-approval.png')
    await dialog.$('.approval-approve').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I ran both inspections.')
    await expect(dialog).not.toBeDisplayed()
    await scenario.assertComplete()
  })
})
