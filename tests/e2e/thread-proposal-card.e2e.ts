import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedThreadProposalFixture } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Visual eval for the model-proposed-thread card (`propose_thread`). The card's
// DOM, its three states and the start/dismiss wiring are covered at component
// tier in `src/renderer/views/thread-proposal-card.test.ts`; this proves the
// offer renders in the real Electron transcript — as an inline card with no
// modal over it — and captures the standing-offer and dismissed states.
describe('a model-proposed thread', () => {
  before(async () => {
    resetUserData()
    seedThreadProposalFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('offers the thread inline in the transcript, not as a prompt', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    const card = $('.messages-list .thread-proposal')
    await card.waitForDisplayed({ timeout: 30_000 })

    const state = await browser.execute(() => {
      const proposal = document.querySelector('.thread-proposal')
      return {
        status: proposal instanceof HTMLElement ? (proposal.dataset['proposalStatus'] ?? '') : '',
        open: proposal instanceof HTMLDetailsElement && proposal.open,
        title: proposal?.querySelector('.thread-proposal-title')?.textContent ?? '',
        summary: proposal?.querySelector('.thread-proposal-summary')?.textContent ?? '',
        checkout: proposal?.querySelector('[data-chip="worktree"]')?.textContent ?? '',
        promptOpen:
          proposal?.querySelector('.thread-proposal-prompt') instanceof HTMLDetailsElement &&
          proposal.querySelector<HTMLDetailsElement>('.thread-proposal-prompt')?.open === true,
        // An offer never blocks: no approval dialog should be up.
        approvalOpen: Boolean(document.querySelector('.approval-dialog[open]')),
      }
    })

    expect(state.status).toBe('pending')
    expect(state.open).toBe(true)
    expect(state.title).toContain('Retire the legacy settings parser')
    expect(state.summary).toContain('Zod schema')
    expect(state.checkout).toContain('own checkout')
    expect(state.promptOpen).toBe(false)
    expect(state.approvalOpen).toBe(false)

    await saveElementScreenshot('.thread-proposal', 'thread-proposal-pending.png')
  })

  it('settles in place when dismissed, and can be brought back', async () => {
    await $('.thread-proposal .thread-proposal-dismiss').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const proposal = document.querySelector('.thread-proposal')
          return proposal instanceof HTMLElement ? (proposal.dataset['proposalStatus'] ?? '') : ''
        })) === 'dismissed',
      { timeout: 10_000, timeoutMsg: 'the card did not settle as dismissed' },
    )

    const collapsed = await browser.execute(() => {
      const proposal = document.querySelector('.thread-proposal')
      return {
        open: proposal instanceof HTMLDetailsElement && proposal.open,
        state: proposal?.querySelector('.thread-proposal-state')?.textContent ?? '',
        // The card stays in the transcript rather than disappearing.
        present: Boolean(proposal),
      }
    })
    expect(collapsed.present).toBe(true)
    expect(collapsed.open).toBe(false)
    expect(collapsed.state).toContain('Dismissed')

    await saveElementScreenshot('.thread-proposal', 'thread-proposal-dismissed.png')

    // Expanding a settled card offers the undo.
    await $('.thread-proposal .thread-proposal-header').click()
    await $('.thread-proposal .thread-proposal-restore').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const proposal = document.querySelector('.thread-proposal')
          return proposal instanceof HTMLElement ? (proposal.dataset['proposalStatus'] ?? '') : ''
        })) === 'pending',
      { timeout: 10_000, timeoutMsg: 'the dismissal was not undone' },
    )
  })

  it('keeps the answer after an app restart', async () => {
    await $('.thread-proposal .thread-proposal-dismiss').click()
    // The decision autosave is debounced; give it a moment to reach the store.
    await browser.pause(1_000)
    await browser.reloadSession()

    await $('.messages-list').waitForExist({ timeout: 30_000 })
    const card = $('.messages-list .thread-proposal')
    await card.waitForExist({ timeout: 30_000 })
    const status = await browser.execute(() => {
      const proposal = document.querySelector('.thread-proposal')
      return proposal instanceof HTMLElement ? (proposal.dataset['proposalStatus'] ?? '') : ''
    })
    expect(status).toBe('dismissed')
  })
})
