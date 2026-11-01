import { $, browser, expect } from '@wdio/globals'
import {
  expectAssistantReply,
  prepareMockToolTurn,
  prepareMockTurn,
} from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { submitComposer } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-command-phase'

/**
 * The newest visible phase label reads `text` for `state`. A collapsed rollup
 * repeats a live command's stage in its own header, so the label checked is
 * the one on screen rather than one nested in a closed disclosure.
 */
async function expectLatestPhase(state: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const seen = await browser.execute(() => {
        const visible = Array.from(
          document.querySelectorAll<HTMLElement>('.tool-command-phase'),
        ).filter((label) => label.getClientRects().length > 0)
        const latest = visible.at(-1)
        return latest ? [latest.dataset['phase'] ?? '', latest.textContent] : null
      })
      return seen?.[0] === state && seen[1] === text
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `Expected a visible "${text}" (${state}) command phase`,
    },
  )
}

describe('command phases on the tool card (#3956)', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      // Every command asks first, on every host, so each stage is reachable
      // whether or not this machine has a working OS sandbox.
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows a command waiting for approval, then one that never started', async () => {
    const scenario = await prepareMockToolTurn(
      'Open the draft pull request.',
      { name: 'run_shell', args: { command: 'gh pr create --draft --title "Phase evidence"' } },
      'I left the pull request unopened.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expectLatestPhase('awaiting_approval', 'Waiting for approval')
    // The activity row agrees: a command waiting on the user is not running.
    await expect($('.agent-activity')).toHaveText(expect.stringContaining('Waiting for approval…'))
    await saveAppScreenshot('command-phase-awaiting-approval.png')

    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I left the pull request unopened.')
    await scenario.assertComplete()
    // Declined before launch: the card must not read as a run with empty output.
    // A declined call stays inside the turn's rollup, like an interrupted one.
    await $('.tool-card-rollup > summary').click()
    await expectLatestPhase('not_started', 'Did not start')
    await saveElementScreenshot(
      '.msg-assistant:has(.tool-command-phase)',
      'command-phase-not-started.png',
    )
  })

  it('keeps a launched command that timed out apart from one that never started', async () => {
    const scenario = await prepareMockTurn('Run the slow check.', [
      { toolCalls: [{ name: 'run_shell', args: { command: 'sleep 5', timeout_ms: 1_000 } }] },
      {
        text: 'The slow check timed out.',
        expectToolResults: [{ name: 'run_shell', includes: 'timed out' }],
      },
    ])
    await submitComposer()
    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await dialog.$('.approval-approve').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The slow check timed out.')
    await scenario.assertComplete()
    await expectLatestPhase('timed_out', 'Timed out')
    await saveElementScreenshot(
      '.msg-assistant:has(.tool-command-phase[data-phase="timed_out"])',
      'command-phase-timed-out.png',
    )
  })
})
