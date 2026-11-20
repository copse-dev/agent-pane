import { installMockScenario } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  seedThreadProposalFixture,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// Accepting a `propose_thread` card starts the new thread in the background and
// leaves the user on the thread that offered it (#4112). An approval the new
// thread raises must reach the user there: left behind a sidebar bell, a bridged
// ACP agent's tool call waited unseen until its MCP client timed out after 300 s.
// Component tier: `approval-dialog-thread-scope.test.ts` ("threads started from
// a proposal"). This proves the prompt paints over the real source transcript.
describe('an approval from a thread started from a proposal', () => {
  before(async () => {
    resetUserData()
    seedThreadProposalFixture(seedStableWorkspace())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('surfaces over the offering thread and names the thread asking', async () => {
    await $('.thread-proposal-start').waitForDisplayed({ timeout: 30_000 })
    await installMockScenario(
      {
        title: 'Retire the legacy settings parser',
        turns: [
          {
            user: { includes: 'Zod schema' },
            responses: [
              { toolCalls: [{ name: 'run_shell', args: { command: 'npm install' } }] },
              {
                text: 'The dependency installation was declined.',
                expectToolResults: [{ name: 'run_shell' }],
              },
            ],
          },
        ],
      },
      null,
    )
    await $('.thread-proposal-start').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run package install?')
    await expect(dialog.$('.approval-origin')).toHaveText(
      'From the thread “Retire the legacy settings parser”',
    )

    const state = await browser.execute(() => {
      const selected = document.querySelector('.chat-row.selected')
      const proposed = [...document.querySelectorAll('.chat-row')].find((row) =>
        row.textContent.includes('Retire the legacy settings parser'),
      )
      return {
        // Starting the proposal did not navigate: the source stays on screen.
        selectedTitle: selected?.textContent ?? '',
        proposalStatus:
          document.querySelector('.thread-proposal')?.getAttribute('data-proposal-status') ?? '',
        // The prompt is on screen, so nothing is left waiting behind a bell.
        proposedRowFlagged: proposed?.classList.contains('needs-attention') ?? null,
      }
    })
    expect(state.selectedTitle).toContain('Config loader guard')
    expect(state.proposalStatus).toBe('started')
    expect(state.proposedRowFlagged).toBe(false)

    await saveAppScreenshot('proposed-thread-approval-over-source.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
