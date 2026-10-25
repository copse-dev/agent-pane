import { installMockScenario } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetUserData,
  seedStableWorkspace,
  seedThreadProposalFixture,
} from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

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

describe('a proposed thread without an isolated checkout', () => {
  let workspace = ''

  before(() => {
    // Explicit worktree requests fail closed for a real non-Git folder.
    workspace = mkdtempSync(join(tmpdir(), 'copse-proposal-consent-'))
  })

  before(async () => {
    resetUserData()
    seedThreadProposalFixture(workspace)
    await browser.reloadSession()
    await $('.thread-proposal-start').waitForDisplayed({ timeout: 10_000 })
  })

  after(() => {
    resetUserData()
    if (workspace) removeE2eTree(workspace)
  })

  it('reports unavailable isolation without dispatching or consuming the offer', async () => {
    await $('.thread-proposal-start').click()
    const error = $('.toast-error')
    await expect(error).toHaveText(
      expect.stringContaining('Isolated worktree is unavailable: not git'),
    )
    await expect($('.messages-list .msg-user')).not.toExist()
    await expect($('.messages-list .msg-assistant')).not.toExist()
    await saveElementScreenshot('#toast-host', 'thread-proposal-isolation-refused.png')
    // This is the expected refusal asserted above, not an ignored error.
    await error.click()
    await $('.chat-row*=Config loader guard').click()
    const card = $('.thread-proposal')
    await card.waitForDisplayed({ timeout: 10_000 })
    await expect(card).toHaveAttribute('data-proposal-status', 'pending')
    await expect($('.thread-proposal-start')).toBeEnabled()
  })
})

describe('starting a proposed thread in an isolated checkout', () => {
  before(async () => {
    resetUserData()
    seedThreadProposalFixture(seedStableWorkspace())
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('starts the mock agent only after creating the worktree', async () => {
    await $('.thread-proposal-start').waitForDisplayed({ timeout: 10_000 })
    await installMockScenario(
      {
        title: 'Config loader guard',
        turns: [
          {
            user: { includes: 'config' },
            responses: [{ text: 'The config loader guard is ready for review.' }],
          },
        ],
      },
      null,
    )
    await $('.thread-proposal-start').click()
    await $('.messages-list .msg-user').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll('.msg-assistant .message-text')].some((message) =>
            message.textContent.includes('The config loader guard is ready for review.'),
          ),
        ),
      { timeout: 30_000, timeoutMsg: 'the isolated proposal did not reach the mock agent' },
    )
    await waitForAgentIdle()
    // Seed a real pending change in the newly created checkout so the sidebar
    // glyph does not depend on incidental files generated by the CI environment.
    const checkout = await browser.execute(async () => {
      const threads = await window.api.threads.loadProject('e2e-thread-proposal-project')
      return threads.find((thread) => thread.title === 'Retire the legacy settings parser')
        ?.worktree?.path
    })
    if (!checkout) throw new Error('The proposed thread did not create an isolated checkout')
    writeFileSync(join(checkout, 'e2e-proposed-change.txt'), 'Proposed checkout preview fixture\n')
    await $('.chat-row*=Retire the legacy settings parser')
      .$('.chat-changes-status')
      .waitForDisplayed({ timeout: 15_000 })
    // Progress refreshes can replace the source thread's sidebar row between
    // WebDriver's lookup and click. Retry only that stale-node race, always
    // resolving a fresh row; any other click failure remains a real failure.
    await browser.waitUntil(
      async () => {
        try {
          await $('.chat-row*=Config loader guard').click()
          return true
        } catch (error) {
          if (error instanceof Error && /stale element/i.test(error.message)) return false
          throw error
        }
      },
      {
        timeout: 10_000,
        timeoutMsg: 'the proposal source thread did not stay clickable after the agent stopped',
      },
    )
    await expect($('.thread-proposal')).toHaveAttribute('data-proposal-status', 'started')
    await expect($('.thread-proposal-state')).toHaveText(expect.stringContaining('Thread started'))
    // Returning to the source can rehydrate and replace its card. Capture the
    // persistent app shell, not a WebDriver reference to that replaceable node.
    const summary = await browser.execute(async () => {
      const row = [...document.querySelectorAll('.chat-row')].find((row) =>
        row.textContent.includes('Retire the legacy settings parser'),
      )
      const threadId = row?.getAttribute('data-thread-id')
      if (!threadId) throw new Error('Missing proposed thread')
      return window.api.git.threadChangeSummary(
        [{ projectId: 'e2e-thread-proposal-project', threadId }],
        { fresh: true },
      )
    })
    expect(summary).toEqual([{ dirty: true }])
    await expect(
      $('.chat-row*=Retire the legacy settings parser').$('.chat-changes-status'),
    ).toBeDisplayed()
    await saveAppScreenshot('thread-proposal-started-isolated.png')
  })
})
