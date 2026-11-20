import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { assertScheduleHeadingKeepsTitle } from './helpers/text-fit.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-automation-attention'
const SCHEDULE_ID = 'schedule-ci-review-attention'
const ASK_PROMPT = 'Investigate the CI failures and ask which failures to focus on.'
const REVIEW_DONE = 'The automated CI review is complete. I saved the question for later.'
const FOLLOW_UP = 'Ask me which failure to investigate next.'

interface AutomationScheduleState {
  sectionExpanded: string | null
  sectionBellCount: number
  runCount: string | null
  expanded: string | null
  headerBellCount: number | null
  runs: { threadId: string | null; displayed: boolean; attentionDisplayed: boolean }[]
}

// The sidebar replaces its rows on attention/status updates and toggle clicks.
// Serialize one document-root read instead of retaining WebDriver parent/row handles.
function readAutomationSchedule(scheduleId: string): AutomationScheduleState {
  const schedule = document.querySelector(
    `.automation-schedule-group[data-schedule-id="${CSS.escape(scheduleId)}"]`,
  )
  return {
    sectionExpanded:
      document.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded') ?? null,
    sectionBellCount: document.querySelectorAll('.automation-threads-toggle .chat-attention-bell')
      .length,
    runCount: schedule?.querySelector('.automation-schedule-count')?.textContent.trim() ?? null,
    expanded:
      schedule?.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded') ?? null,
    headerBellCount:
      schedule?.querySelectorAll('.automation-schedule-toggle .chat-attention-bell').length ?? null,
    runs: Array.from(
      schedule?.querySelectorAll('.automation-schedule-runs .chat-row') ?? [],
      (row) => {
        const bell = row.querySelector('.chat-attention-bell')
        return {
          threadId: row.getAttribute('data-thread-id'),
          displayed: row.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          attentionDisplayed:
            bell?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ?? false,
        }
      },
    ),
  }
}

describe('automation attention grouping', function () {
  this.timeout(180_000)
  before(async () => {
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    const projectRoot = join(dirname(worktreesRoot), 'automation-attention-project')
    mkdirSync(projectRoot, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' })
    }
    if (!existsSync(join(projectRoot, '.git'))) {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'e2e@example.invalid')
      git('config', 'user.name', 'Copse E2E')
      git('config', 'init.defaultBranch', 'main')
      writeFileSync(join(projectRoot, 'README.md'), 'automation attention fixture\n')
      git('add', 'README.md')
      git('commit', '-qm', 'seed')
    }

    seedEmptyProject(projectRoot, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: 'regular-chat',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'regular-chat',
          title: 'Release planning',
          status: 'idle',
          messages: [
            {
              id: 'regular-chat-message',
              role: 'user',
              content: 'Plan the release.',
              toolCalls: [],
              createdAt: 1_786_000_300_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1_786_000_300_000,
          updatedAt: 1_786_000_300_000,
        },
        ...[1_786_000_180_000, 1_785_913_780_000, 1_785_827_380_000].map((timestamp, index) => ({
          id: `automation-history-${String(index + 1)}`,
          title: 'CI review',
          status: 'idle',
          messages: [
            {
              id: `automation-history-answer-${String(index + 1)}`,
              role: 'assistant',
              content: 'The historical CI review completed.',
              toolCalls: [],
              createdAt: timestamp,
            },
          ],
          usage: { inputTokens: 100, outputTokens: 25 },
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'CI review',
            triggeredAt: timestamp - 60_000,
          },
          createdAt: timestamp - 60_000,
          updatedAt: timestamp,
        })),
      ],
      pluginDisabled: [],
      packMigration: { automationsEnablement: true },
      pack: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'CI review',
                cron: '0 0 1 1 *',
                prompt: ASK_PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: true,
                maxLiveWorktrees: 1,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
                lastCreatedThreadId: 'automation-history-1',
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('reveals only the automation run waiting for attention', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const unattended = await installMockScenario(
      {
        title: 'CI review',
        turns: [
          {
            user: ASK_PROMPT,
            responses: [
              {
                toolCalls: [
                  {
                    name: 'ask_user',
                    args: {
                      questions: [
                        {
                          question: 'Which CI failure should I investigate?',
                          options: ['Latest failure', 'All failures'],
                        },
                      ],
                    },
                  },
                ],
              },
              {
                text: REVIEW_DONE,
                expectToolResults: [{ name: 'ask_user', includes: 'Saved for human review' }],
              },
            ],
            allowAbort: true,
          },
        ],
      },
      null,
    )
    // Keep what `runNow` answered. It reports whether the schedule was found at
    // all, which is the first fork in the diagnosis below — and the old code
    // awaited it only to discard it.
    const runNowResult = await browser.execute(
      async ([projectId, scheduleId]) => {
        const host = window
        return await host.api.automations.runNow(projectId, scheduleId)
      },
      [PROJECT_ID, SCHEDULE_ID] as const,
    )

    assert.equal(runNowResult.disposition, 'started')
    const startedThreadId = runNowResult.threadId
    assert.ok(startedThreadId)
    await unattended.waitForComplete(30_000)
    await unattended.assertComplete()
    await browser.waitUntil(
      async () =>
        await browser.execute(
          async ({ projectId, threadId }) => {
            const thread = (await window.api.threads.loadProject(projectId)).find(
              (candidate) => candidate.id === threadId,
            )
            // This sidebar endpoint returns metadata. The full reply is
            // checked through the conversation after selecting the run.
            return thread?.status === 'idle'
          },
          { projectId: PROJECT_ID, threadId: startedThreadId },
        ),
      { timeout: 30_000, timeoutMsg: 'The unattended question blocked independent completion' },
    )
    await expect($('#ask-user-dialog')).not.toBeDisplayed()
    const automationToggle = $('.automation-threads-toggle')
    await expect(automationToggle).toHaveAttribute('aria-expanded', 'false')
    const scheduleSelector = `.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`
    // Wait for the open section to render the schedule, then read it from the root.
    const readRenderedSchedule = async (): Promise<AutomationScheduleState> => {
      await $(`${scheduleSelector} .automation-schedule-toggle`).waitForExist({ timeout: 5_000 })
      return await browser.execute(readAutomationSchedule, SCHEDULE_ID)
    }

    // A later human follow-up is interactive. Park its provider before asking,
    // return to the ordinary chat, then let the actual ask_user open attention.
    await automationToggle.click()
    if ((await readRenderedSchedule()).expanded !== 'true')
      await $(`${scheduleSelector} .automation-schedule-toggle`).click()
    await $(`${scheduleSelector} .chat-row[data-thread-id="${startedThreadId}"]`).click()
    await expectAssistantReply(REVIEW_DONE)
    await expect($('.stop-btn')).not.toBeDisplayed()
    const followUp = await installMockScenario({
      title: 'CI review',
      turns: [
        {
          user: FOLLOW_UP,
          responses: [
            {
              waitFor: 'before-interactive-question',
              toolCalls: [
                {
                  name: 'ask_user',
                  args: {
                    questions: [
                      {
                        question: 'Which CI failure should I investigate?',
                        options: ['Latest failure', 'All failures'],
                      },
                    ],
                  },
                },
              ],
            },
            { text: 'The CI investigation was cancelled.' },
          ],
          allowAbort: true,
        },
      ],
    })
    await setComposerValue(FOLLOW_UP)
    await submitComposer()
    await followUp.waitForHold('before-interactive-question', 30_000)
    await $('.chat-row[data-thread-id="regular-chat"]').click()
    if ((await readRenderedSchedule()).expanded === 'true')
      await $(`${scheduleSelector} .automation-schedule-toggle`).click()
    if ((await browser.execute(readAutomationSchedule, SCHEDULE_ID)).sectionExpanded === 'true')
      await automationToggle.click()
    await expect(automationToggle).toHaveAttribute('aria-expanded', 'false')
    await expect($('#ask-user-dialog')).not.toBeDisplayed()
    await followUp.release('before-interactive-question')
    // Only the genuine interactive question should reveal the run. Saved
    // unattended questions never hold the run or interrupt the ordinary chat.
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(readAutomationSchedule, SCHEDULE_ID)).sectionExpanded === 'true',
        { timeout: 20_000 },
      )
    } catch {
      const startedThreadId = runNowResult.threadId
      const [toggleExists, expanded, groupCount, rowCount, bellCount, titles, sidebarState] =
        await Promise.all([
          automationToggle.isExisting(),
          automationToggle.getAttribute('aria-expanded').catch(() => '<unreadable>'),
          $$('.automation-schedule-group').length,
          $$('.chats-list .chat-row').length,
          $$('.chat-attention-bell').length,
          browser.execute(() =>
            Array.from(document.querySelectorAll('.chats-list .chat-title'))
              .map((node) => node.textContent)
              .join(' | '),
          ),
          // Readable while collapsed. `.automation-threads-count` is
          // `scheduleGroups.size`, and `.automation-threads-running` is set by
          // any automation thread in `running` status.
          browser.execute(() => ({
            groupCountLabel:
              document.querySelector('.automation-threads-count')?.textContent ?? '<absent>',
            runningIndicator: document.querySelector('.automation-threads-running') !== null,
          })),
        ])
      // Everything above still cannot see an automation *row*: they are built
      // only inside `if (automationExpanded)`, so the collapsed group hides
      // exactly what needs inspecting. Round two reported
      // `knownThreadIds: 1, startedThreadPresent: false` and that was vacuous —
      // one row is the unrelated chat, and the run could not have appeared
      // whether it existed or not.
      //
      // So expand by hand before reading. Clicking the toggle sets
      // `expandedAutomationProjects` and re-renders with every run present.
      // This runs only on the failure path, after the assertion has already
      // been lost, so it cannot affect a passing run.
      await automationToggle.click().catch(() => undefined)
      // Two levels collapse independently. Opening the Automations group still
      // leaves each *schedule* closed unless it has an active or attention run
      // (`scheduleRevealed` in projects-pane.ts), and a closed schedule renders
      // its count but none of its rows — which is why the previous round read
      // `automationRows: 0` next to `scheduleCounts: "4 runs"`. Open the
      // schedule too.
      await $('.automation-schedule-toggle')
        .click()
        .catch(() => undefined)
      const revealed = await browser
        .waitUntil(async () => (await $$('.automation-thread-rows [data-thread-id]').length) > 0, {
          timeout: 5_000,
        })
        .then(() => true)
        .catch(() => false)
      const forced = await browser.execute((threadId: string) => {
        const rows = Array.from(
          document.querySelectorAll('.automation-thread-rows [data-thread-id]'),
        )
        return {
          automationRows: rows.length,
          startedThreadPresent:
            threadId !== '' &&
            rows.some((node) => node.getAttribute('data-thread-id') === threadId),
          // Each row's id, its classes (status lives there), and its text —
          // enough to say whether the started run is present and what state the
          // sidebar thinks it is in.
          rowDetail: rows
            .map(
              (node) =>
                `${(node.getAttribute('data-thread-id') ?? '').slice(0, 8)}[${node.className}]` +
                `"${node.textContent.slice(0, 40)}"`,
            )
            .join(' | '),
          scheduleCounts: Array.from(document.querySelectorAll('.automation-schedule-count'))
            .map((node) => node.textContent)
            .join(' | '),
        }
      }, startedThreadId)
      // Everything above reads the DOM, and the DOM cannot say *why* the run
      // never started: an automation row carries only `is-automation` and
      // `selected` (projects-pane.ts), so a thread that failed its checkout and
      // a thread the controller never picked up render identically.
      //
      // The thread's own record separates them. `startThread`
      // (renderer/controller/automations.ts) clears `draftPrompt` only *after*
      // `prepareCheckout` resolves, and dispatch then moves the thread to
      // `running`, so:
      //   - draft kept, still `idle` → it never got past the checkout, either by
      //     throwing (the catch logs `[automations] Failed to start scheduled
      //     task:`, now printed in the shard digest) or by `isPendingAutomation`
      //     rejecting the thread — and the fields below say which term.
      //   - draft cleared, `running` → it dispatched and died later, which is a
      //     different bug in a different place.
      // Read over IPC rather than from the store: the renderer does not expose
      // the store, and `loadProject` is the same call the controller makes.
      // Message counts are deliberately absent — `loadProject` returns metadata
      // only, so a count read here is always 0 and would read as "no user
      // message was ever added" even on a run that dispatched normally.
      //
      // `activeProjectSelected` covers the remaining silent exit. Four separate
      // guards abandon the start with no log and no state change when the
      // renderer's `activeProjectId` is not this project — `receiveTrigger`
      // before it ever calls `startThread`, and `startThread` itself on entry
      // and twice more across its awaits. Those look identical to
      // `isPendingAutomation` rejecting the thread, so read the one thing the
      // DOM does expose: a `.chat-row` is given `selected` only when
      // `project.id === activeProjectId && thread.id === activeThreadId`
      // (projects-pane.ts), and the seed pins `activeThreadId` to
      // `regular-chat`. So a selected `regular-chat` row proves the renderer
      // agrees on the active project, and its absence indicts those guards.
      //
      // Caveat worth keeping in mind when reading the result: this record comes
      // from disk, while the guards above read the in-memory store, so a lag
      // between the two would show as a kept draft on a thread the store had
      // already advanced.
      const threadRecord = await browser.execute(
        async ([projectId, threadId]) => {
          const host = window
          if (threadId === '') return 'runNow returned no thread id'
          const loaded = await host.api.threads.loadProject(projectId)
          const thread = loaded.find((candidate) => candidate.id === threadId)
          if (!thread)
            return `started thread absent from loadProject (${String(loaded.length)} thread(s))`
          return JSON.stringify({
            activeProjectSelected:
              document.querySelector('.chat-row.selected[data-thread-id="regular-chat"]') !== null,
            status: thread.status,
            // The three `isPendingAutomation` terms, so a silent early return
            // names the term that rejected it.
            hasAutomation: thread.automation !== undefined,
            draftPromptKept: Boolean(thread.draftPrompt?.trim()),
          })
        },
        [PROJECT_ID, startedThreadId] as const,
      )
      throw new Error(
        'attention did not reveal the Automations group — ' +
          `runNow returned ${JSON.stringify(runNowResult)}, ` +
          `.automation-threads-toggle ${toggleExists ? 'exists' : 'is ABSENT'} ` +
          `with aria-expanded=${String(expanded)}, ` +
          `${String(groupCount)} schedule group(s), ${String(rowCount)} sidebar row(s), ` +
          `${String(bellCount)} attention bell(s), titles: ${titles || '<none>'}, ` +
          `sidebar: ${JSON.stringify(sidebarState)}, ` +
          `after forcing the group open (revealed=${String(revealed)}): ${JSON.stringify(forced)}, ` +
          `started thread record: ${threadRecord}`,
      )
    }
    const waitingThreadId = runNowResult.threadId
    assert.ok(waitingThreadId, 'runNow must return the newly started thread ID')
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(readAutomationSchedule, SCHEDULE_ID)
        return (
          state.sectionExpanded === 'true' &&
          state.sectionBellCount === 0 &&
          state.runCount === '4 runs' &&
          state.headerBellCount === 0 &&
          state.expanded === 'false' &&
          state.runs.length === 1 &&
          state.runs[0]?.threadId === waitingThreadId &&
          state.runs[0].displayed &&
          state.runs[0].attentionDisplayed
        )
      },
      { timeout: 5_000, timeoutMsg: 'attention reveal should show only the newly waiting run' },
    )
    const revealed = await browser.execute(readAutomationSchedule, SCHEDULE_ID)
    assert.equal(revealed.sectionExpanded, 'true')
    assert.equal(revealed.sectionBellCount, 0)
    assert.equal(revealed.runCount, '4 runs')
    assert.equal(revealed.headerBellCount, 0)
    assert.equal(revealed.expanded, 'false')
    assert.deepEqual(revealed.runs, [
      { threadId: waitingThreadId, displayed: true, attentionDisplayed: true },
    ])
    // The waiting run was started by `runNow` moments ago, so its trigger time
    // is the wall clock; pin only that text for the capture.
    const restoreRunTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    await assertScheduleHeadingKeepsTitle(scheduleSelector)
    await saveElementScreenshot('.automation-threads-group', 'automation-attention-group.png')
    await restoreRunTime()

    await $(`${scheduleSelector} .automation-schedule-toggle`).click()
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(readAutomationSchedule, SCHEDULE_ID)
        return state.expanded === 'true' && state.runs.length === 4
      },
      { timeout: 5_000, timeoutMsg: 'expanding the schedule should reveal all four runs' },
    )
    const expanded = await browser.execute(readAutomationSchedule, SCHEDULE_ID)
    assert.equal(expanded.expanded, 'true')
    assert.deepEqual(
      expanded.runs.map((run) => run.threadId).sort(),
      [
        waitingThreadId,
        'automation-history-1',
        'automation-history-2',
        'automation-history-3',
      ].sort(),
    )
    await $(`${scheduleSelector} .chat-row[data-thread-id="${waitingThreadId}"]`).click()
    const askDialog = $('#ask-user-dialog')
    await askDialog.waitForDisplayed({ timeout: 10_000 })
    await askDialog.$('.ask-user-cancel').click()
    await followUp.waitForComplete()
    await followUp.assertComplete()
  })
})
