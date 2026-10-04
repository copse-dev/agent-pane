import type { Thread } from '../../src/shared/types/index.ts'
import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

// The Activity panel (docs/plans/mission-control.md, slice 1) over a real agent
// loop: a thread the user is NOT looking at stops on a shell approval while
// another thread is working. The panel lists both by claim on attention, and
// approving from it reaches main — the tool really runs and the thread
// finishes — without the user leaving the thread they are in.
//
// Electron rather than the browser tier because the behavior under test is the
// answer crossing real IPC (`approval:respond`) and unblocking the agent loop.

const PROJECT_ID = 'e2e-activity-panel'
const AUTH_THREAD = 'e2e-activity-auth'
const AUDIT_THREAD = 'e2e-activity-audit'
const AUTH_PROMPT = 'Run the auth verification script.'
const AUTH_COMMAND = "printf 'auth-check-passed\\n'"
const AUTH_REPLY = 'The auth verification script passed.'
const AUDIT_PROMPT = 'Audit the dependency tree.'
const AUDIT_REPLY = 'The dependency audit found nothing to update.'
const SEEDED_AT = 1_786_000_000_000

function seededThread(id: string, title: string, request: string, answer: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: request,
        toolCalls: [],
        createdAt: SEEDED_AT,
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        content: answer,
        toolCalls: [],
        createdAt: SEEDED_AT + 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT + 1,
  }
}

async function openActivityPanel(): Promise<void> {
  await $('.prompt-input').click()
  await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'a'])
  await $('#activity-panel').waitForDisplayed({ timeout: 10_000 })
}

function rowSelector(group: string, threadId: string): string {
  return `#activity-panel .activity-group[data-group="${group}"] .activity-row[data-thread-id="${threadId}"]`
}

describe('Activity panel', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: AUTH_THREAD,
      [`threads:${PROJECT_ID}`]: [
        seededThread(
          AUTH_THREAD,
          'Refactor auth',
          'Tidy the session handling in the auth module.',
          'The session handling is tidied.',
        ),
        seededThread(
          AUDIT_THREAD,
          'Dependency audit',
          'List the direct dependencies.',
          'There are no direct dependencies yet.',
        ),
        ...Array.from({ length: 10 }, (_, index) => ({
          ...seededThread(
            `e2e-activity-recent-${String(index)}`,
            `Recent run ${String(index)}`,
            'List the recent run.',
            'The recent run completed.',
          ),
          unreadAt: SEEDED_AT + index + 2,
        })),
      ],
    })
    // One write: seedE2eViewport replaces the settings file, so a separate
    // writeSettings before it would be lost.
    seedE2eViewport(undefined, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      // Every shell command asks, sandbox or not, so the approval is deterministic.
      autoRunSandboxCommands: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('answers a background approval from the panel while another thread works', async () => {
    // Thread A asks to run a command, then the user moves on to thread B.
    await $(`.chat-row[data-thread-id="${AUTH_THREAD}"].selected`).waitForExist({ timeout: 30_000 })
    const auth = await installMockScenario({
      title: 'Refactor auth',
      turns: [
        {
          user: AUTH_PROMPT,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: AUTH_COMMAND } }] },
            {
              expectToolResults: [{ name: 'run_shell', includes: 'auth-check-passed' }],
              text: AUTH_REPLY,
            },
          ],
        },
      ],
    })
    await setComposerValue(AUTH_PROMPT)
    await submitComposer()
    const approvalDialog = $('#approval-dialog')
    await approvalDialog.waitForDisplayed({ timeout: 30_000 })
    await expect(approvalDialog.$('.approval-heading')).toHaveText('Run shell command?')

    await $(`.chat-row[data-thread-id="${AUDIT_THREAD}"]`).click()
    await $(`.chat-row[data-thread-id="${AUDIT_THREAD}"].selected`).waitForExist({
      timeout: 10_000,
    })
    // The prompt follows focus: it leaves the screen and A's row gets a bell.
    await approvalDialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await $(`.chat-row[data-thread-id="${AUTH_THREAD}"] .chat-attention-bell`).waitForExist({
      timeout: 10_000,
    })

    // Thread B starts a run that holds, so it is genuinely working.
    const audit = await installMockScenario({
      title: 'Dependency audit',
      turns: [{ user: AUDIT_PROMPT, responses: [{ waitFor: 'audit', text: AUDIT_REPLY }] }],
    })
    await setComposerValue(AUDIT_PROMPT)
    await submitComposer()
    await audit.waitForHold('audit')

    // The sidebar header's bell counts the waiting thread.
    await expect($('.projects-activity-btn')).toHaveAttribute(
      'aria-label',
      'Activity: 1 thread needs you',
    )

    await openActivityPanel()
    const needsRow = $(rowSelector('needs-you', AUTH_THREAD))
    await needsRow.waitForDisplayed({ timeout: 10_000 })
    await expect(needsRow).toHaveAttribute('data-state', 'needs-approval')
    await expect(needsRow.$('.activity-thread')).toHaveText('Refactor auth')
    await expect(needsRow.$('.activity-state')).toHaveText('Approval')
    await expect(needsRow.$('.activity-glyph')).toHaveAttribute('data-icon', 'shield')
    await expect(needsRow.$('.activity-want-code')).toHaveText(AUTH_COMMAND)
    await expect(needsRow.$('.activity-project')).toHaveText('workspace')
    const workingRow = $(rowSelector('working', AUDIT_THREAD))
    await expect(workingRow).toBeDisplayed()
    await expect(workingRow.$('.activity-state')).toHaveText('Running')
    assert.deepEqual(
      await $$('#activity-panel .activity-group').map((group) => group.getAttribute('data-group')),
      ['needs-you', 'working', 'recent'],
    )
    // The most urgent row is selected and focused; its label leads with its state.
    await expect(needsRow).toHaveAttribute('data-selected', 'true')
    await expect(needsRow.$('.activity-row-open')).toBeFocused()
    const label = await needsRow.$('.activity-row-open').getAttribute('aria-label')
    assert.match(label ?? '', /^Needs approval: Run shell command\? — printf/)

    // The list only scans; the detail beside it shows the request exactly as the
    // prompt does, and the once-only Approve action exists only there.
    await expect($('#activity-panel .activity-list .activity-approve')).not.toBeExisting()
    const detail = $('#activity-panel .activity-detail')
    const requestId = await needsRow.getAttribute('data-request-id')
    if (!requestId) throw new Error('Missing activity approval request id')
    await expect(detail).toHaveAttribute('data-row-key', `approval:${requestId}`)
    await expect(detail.$('.activity-detail-title')).toHaveText('Refactor auth')
    await expect(detail.$('.activity-review-title')).toHaveText('Run shell command?')
    const fullBody = await browser.execute(
      () =>
        document.querySelector('#activity-panel .activity-detail .approval-body')?.textContent ??
        null,
    )
    assert.equal(fullBody, AUTH_COMMAND, 'the detail shows the full command verbatim')
    const approve = detail.$('.activity-approve')
    await approve.waitForEnabled({ timeout: 5_000 })
    // The detail fits the panel: nothing is clipped or scrolled off sideways.
    const fits = await browser.execute(() => {
      const pane = document.querySelector<HTMLElement>('#activity-panel .activity-detail-body')
      const view = document.querySelector<HTMLElement>('#activity-panel .activity-review')
      if (!pane || !view) return null
      const paneRect = pane.getBoundingClientRect()
      const viewRect = view.getBoundingClientRect()
      return {
        noSideScroll: pane.scrollWidth <= pane.clientWidth,
        inside: viewRect.right <= paneRect.right + 0.5,
      }
    })
    assert.deepEqual(fits, { noSideScroll: true, inside: true })
    await saveAppScreenshot('activity-panel-needs-you.png')

    // The running audit thread makes the global stop shortcut active. Dialog
    // keyboard events must still reach the native Activity panel: Escape closes
    // it, and Enter activates its focused close button.
    await browser.keys('Escape')
    await $('#activity-panel').waitForDisplayed({ reverse: true, timeout: 5_000 })
    await openActivityPanel()
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('#activity-panel .activity-panel-close')?.focus()
    })
    await browser.keys('Enter')
    await $('#activity-panel').waitForDisplayed({ reverse: true, timeout: 5_000 })
    await openActivityPanel()
    await needsRow.waitForDisplayed({ timeout: 10_000 })
    const reopenedDetail = $('#activity-panel .activity-detail')
    const reopenedApprove = reopenedDetail.$('.activity-approve')
    await reopenedApprove.waitForEnabled({ timeout: 5_000 })

    // Scroll the reopened list before approving so the update must preserve it.
    const initialScroll = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('#activity-panel .activity-list')
      if (!list) return { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }
      list.scrollTop = list.scrollHeight
      return {
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        scrollTop: list.scrollTop,
      }
    })
    assert.ok(
      initialScroll.scrollTop > 0,
      `the activity list should scroll before the update (${JSON.stringify(initialScroll)})`,
    )

    // A real approval redraw must leave an unchanged recent row and group as
    // the same Chromium nodes, not recreate a target under the pointer.
    const untouchedSelector = rowSelector('recent', 'e2e-activity-recent-9')
    const untouchedRowId = (await $(untouchedSelector).getElement()).elementId
    const recentGroupId = (
      await $('#activity-panel .activity-group[data-group="recent"]').getElement()
    ).elementId

    // Approve from the panel. The user stays on thread B the whole time.
    await reopenedApprove.click()
    await browser.waitUntil(
      async () => !(await $(rowSelector('needs-you', AUTH_THREAD)).isExisting()),
      {
        timeout: 10_000,
        timeoutMsg: 'expected the approved row to leave Needs you',
      },
    )
    await expect($('#activity-panel .activity-panel-status')).toHaveText(
      'Approved once for Refactor auth.',
    )
    const scrollAfterApproval = await browser.execute(
      () => document.querySelector<HTMLElement>('#activity-panel .activity-list')?.scrollTop ?? 0,
    )
    assert.ok(
      scrollAfterApproval > 0,
      `the activity list should keep its position after the update (scrollTop=${String(scrollAfterApproval)})`,
    )
    await saveAppScreenshot('activity-panel-scroll-preserved.png')
    // Proof the answer reached main: A's tool runs and its turn finishes, so its
    // row lands in Recently finished while B is still working.
    const finishedRow = $(rowSelector('recent', AUTH_THREAD))
    await finishedRow.waitForExist({ timeout: 30_000 })
    await expect(finishedRow).toHaveAttribute('data-state', 'finished')
    assert.equal(
      (await $(untouchedSelector).getElement()).elementId,
      untouchedRowId,
      'unchanged row survives the native approval redraw',
    )
    assert.equal(
      (await $('#activity-panel .activity-group[data-group="recent"]').getElement()).elementId,
      recentGroupId,
      'unchanged group survives the native approval redraw',
    )
    await expect($(rowSelector('working', AUDIT_THREAD))).toBeDisplayed()
    await expect($('#activity-panel .activity-quiet')).toHaveText('Nothing needs you right now.')
    await expect($(`.chat-row[data-thread-id="${AUDIT_THREAD}"]`)).toHaveElementClass('selected')
    await expect(approvalDialog).not.toBeDisplayed()
    await saveAppScreenshot('activity-panel-approved.png')

    // Finish B, then jump to A from the panel with the keyboard and read what ran.
    await audit.release('audit')
    await waitForAgentIdle(15_000)
    await expectAssistantReply(AUDIT_REPLY)
    await audit.assertComplete()

    await browser.waitUntil(async () => await $(rowSelector('recent', AUDIT_THREAD)).isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'expected B to settle into Recently finished',
    })
    // Keyboard only from here: Home to the top row, arrows down to A (the detail
    // follows), then Tab to its Open thread and Enter.
    const focusedRow = (): Promise<{ group: string | null; thread: string | null }> =>
      browser.execute(() => {
        const row = document.activeElement?.closest<HTMLElement>('.activity-row')
        return {
          group: row?.closest<HTMLElement>('.activity-group')?.dataset['group'] ?? null,
          thread: row?.dataset['threadId'] ?? null,
        }
      })
    await browser.keys('Home')
    for (let i = 0; i < 4; i++) {
      const at = await focusedRow()
      if (at.group === 'recent' && at.thread === AUTH_THREAD) break
      await browser.keys('ArrowDown')
    }
    assert.deepEqual(await focusedRow(), { group: 'recent', thread: AUTH_THREAD })
    await expect($('#activity-panel .activity-detail')).toHaveAttribute('data-state', 'finished')
    await browser.keys('Tab')
    await expect($('#activity-panel .activity-detail .activity-open-thread')).toBeFocused()
    await browser.keys('Enter')
    await $('#activity-panel').waitForDisplayed({ reverse: true, timeout: 5_000 })
    await $(`.chat-row[data-thread-id="${AUTH_THREAD}"].selected`).waitForExist({
      timeout: 10_000,
    })
    await expectAssistantReply(AUTH_REPLY)
    await expect($('.tool-card[data-status="done"]')).toBeExisting()
    await auth.assertComplete()
  })
})
