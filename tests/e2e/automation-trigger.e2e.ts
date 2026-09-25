import { installMockScenario } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  pinTextForCapture,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSeedSupervisedTask,
} from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-trigger'
const OTHER_PROJECT_ID = 'e2e-automation-trigger-other'
const PROMPT = 'Review CI and report any failures.'
const SCHEDULE_ID = 'schedule-ci-review'

// What paces the scheduler is not the schedule's own `* * * * *` but the
// supervised `automation_scheduler_tick` task that `automation-service` keeps
// for it: `TaskSupervisor.arm()` sets its timer to the persisted `nextWakeAt`,
// or else to the next *minute boundary*. Left to that, the first tick lands a
// uniformly random 0-60s after boot, which cost every run of this spec up to a
// minute of real time and pushed its CI shard past the per-attempt timeout.
//
// Instead the profile holds the durable scheduler task as a previous session
// left it — waiting on a minute boundary that passed while the app was closed.
// The supervisor coalesces a missed cron occurrence into one run on restart
// (`task-supervisor.test.ts`, "coalesces missed cron occurrences after
// restart"), so the real tick fires as soon as the supervisor loads, matches
// the schedule and creates the thread. `automation-service` retains this task
// rather than enqueuing another, because it is owned by the enabled schedule.
//
// A tick at boot would outrun `installMockScenario`, which needs the renderer
// up: the automation controller starts a pending scheduled run as soon as its
// project is active. So the app opens on another project, where that run
// waits, and the spec switches to the schedule's project once the scenario is
// in place — the controller's `workspace_changed` pickup, or its trigger
// listener if the tick lands after the switch, then starts it.
const MISSED_TICK_AT = 1_786_000_140_000
const SCHEDULER_TICK_TIMEOUT_MS = 30_000

describe('cron automation trigger', function () {
  // A mock agent turn plus checkout preparation, with headroom for a loaded runner.
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    // Scheduled tasks explicitly require worktree isolation. Use a standalone
    // disposable repository: this source checkout is itself a linked worktree,
    // whose external common .git directory is intentionally outside the e2e
    // sandbox and therefore cannot prove the allocation path.
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    const projectRoot = join(dirname(worktreesRoot), 'automation-trigger-project')
    mkdirSync(projectRoot, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' })
    }
    if (!existsSync(join(projectRoot, '.git'))) {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'e2e@example.invalid')
      git('config', 'user.name', 'Copse E2E')
      git('config', 'init.defaultBranch', 'main')
      writeFileSync(join(projectRoot, 'README.md'), 'automation trigger fixture\n')
      git('add', 'README.md')
      git('commit', '-qm', 'seed')
    }

    const otherProjectRoot = join(dirname(worktreesRoot), 'automation-trigger-other-project')
    mkdirSync(otherProjectRoot, { recursive: true })

    seedEmptyProject(projectRoot, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [
        { id: PROJECT_ID, path: projectRoot, name: 'workspace' },
        { id: OTHER_PROJECT_ID, path: otherProjectRoot, name: 'notes' },
      ],
      activeProjectId: OTHER_PROJECT_ID,
      activeThreadId: 'other-chat',
      [`threads:${OTHER_PROJECT_ID}`]: [
        {
          id: 'other-chat',
          title: 'Meeting notes',
          status: 'idle',
          messages: [
            {
              id: 'other-chat-message',
              role: 'user',
              content: 'Summarise the meeting.',
              toolCalls: [],
              createdAt: 1_786_000_200_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1_786_000_200_000,
          updatedAt: 1_786_000_200_000,
        },
      ],
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
              createdAt: 1_786_000_200_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1_786_000_200_000,
          updatedAt: 1_786_000_200_000,
        },
        {
          id: 'automation-history-latest',
          title: 'CI review',
          status: 'idle',
          messages: [
            {
              id: 'automation-history-latest-answer',
              role: 'assistant',
              content: 'The previous CI review passed.',
              toolCalls: [],
              createdAt: 1_786_000_180_000,
            },
          ],
          usage: { inputTokens: 120, outputTokens: 32 },
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'CI review',
            triggeredAt: 1_786_000_120_000,
          },
          createdAt: 1_786_000_120_000,
          updatedAt: 1_786_000_180_000,
        },
        {
          id: 'automation-history-previous',
          title: 'CI review',
          status: 'idle',
          messages: [
            {
              id: 'automation-history-previous-answer',
              role: 'assistant',
              content: 'An earlier CI review passed.',
              toolCalls: [],
              createdAt: 1_785_913_780_000,
            },
          ],
          usage: { inputTokens: 98, outputTokens: 24 },
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'CI review',
            triggeredAt: 1_785_913_720_000,
          },
          createdAt: 1_785_913_720_000,
          updatedAt: 1_785_913_780_000,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'CI review',
                cron: '* * * * *',
                prompt: PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: true,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
                lastCreatedThreadId: 'automation-history-latest',
              },
            ],
          },
        },
      },
    })
    writeSeedSupervisedTask({
      taskId: 'automation-scheduler-tick',
      projectId: PROJECT_ID,
      threadId: SCHEDULE_ID,
      handler: 'automation_scheduler_tick',
      provenance: 'schedule',
      state: 'waiting',
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_120_000,
      trigger: { kind: 'cron', expression: '* * * * *' },
      permissionSnapshot: {
        capturedAt: 1_786_000_000_000,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: false,
      concurrencyClass: 'schedule',
      resourceBudget: { maxDurationMs: 30_000 },
      attempt: 0,
      maxAttempts: 1,
      contentHash: 'automation_scheduler_tick',
      nextWakeAt: MISSED_TICK_AT,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('submits the scheduled prompt and completes a real mock agent turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const scenario = await installMockScenario(
      {
        title: 'CI review',
        turns: [
          {
            user: PROMPT,
            responses: [
              {
                waitFor: 'review-ready',
                text: 'The CI review is complete; no failures were found.',
              },
            ],
          },
        ],
      },
      null,
    )

    // Only now open the schedule's project, so its scheduled run starts
    // against the scenario above rather than the mock's unscripted fallback.
    const scheduleProject = $('.project-row*=workspace')
    await scheduleProject.waitForExist({ timeout: 10_000 })
    await scheduleProject.click()
    // The switch selects the project's newest thread, which is the scheduled
    // run whenever the tick beat the click. Select the ordinary chat so the
    // Automations section starts collapsed either way.
    const regularChat = $('.chat-row[data-thread-id="regular-chat"]')
    await regularChat.waitForExist({ timeout: 15_000 })
    await regularChat.click()
    await browser.waitUntil(
      async () => (await regularChat.getAttribute('class'))?.includes('selected') === true,
      { timeout: 5_000, timeoutMsg: 'the ordinary chat never became the selected thread' },
    )

    const automationGroup = $('.automation-threads-toggle')
    await automationGroup.waitForExist({
      timeout: 10_000,
      timeoutMsg: 'the Automations section never appeared after opening the schedule project',
    })
    assert.equal(await automationGroup.getAttribute('aria-expanded'), 'false')
    assert.equal(await automationGroup.$('.automation-threads-count').getText(), '1')
    await automationGroup.click()

    const scheduleGroup = $(`.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`)
    await scheduleGroup.waitForExist({ timeout: 5_000 })
    assert.equal(await scheduleGroup.$('.automation-schedule-title').getText(), 'CI review')
    await browser.waitUntil(
      async () => (await scheduleGroup.$('.automation-schedule-count').getText()) === '3 runs',
      {
        timeout: SCHEDULER_TICK_TIMEOUT_MS,
        timeoutMsg:
          'the fresh scheduled task never joined its existing schedule group — the persisted ' +
          'scheduler task should have fired its missed tick as soon as the supervisor loaded',
      },
    )
    // Finish checkout/provider startup, then hold the response while opening
    // the scheduled run. Streaming store updates rebuild the entire sidebar
    // and can detach a row between WebDriver locating and clicking it.
    await scenario.waitForHold('review-ready')
    assert.equal(await scheduleGroup.$('.automation-schedule-count').getText(), '3 runs')
    assert.equal(
      await scheduleGroup.$('.automation-schedule-toggle').getAttribute('aria-expanded'),
      'false',
    )
    await scheduleGroup.$('.automation-schedule-toggle').click()

    const scheduledRow = scheduleGroup.$('.automation-schedule-runs .chat-row')
    await scheduledRow.waitForExist({ timeout: 5_000 })
    assert.match(await scheduledRow.getText(), /^Latest · /)
    const scheduledThreadId = await scheduledRow.getAttribute('data-thread-id')
    assert.ok(scheduledThreadId, 'the latest scheduled run must have a thread id')
    // The row is the run the real scheduler just fired, so its time is the
    // wall clock; nothing seeded can stand in for it. Pin only that text.
    const restoreRunTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    await saveElementScreenshot('.automation-threads-group', 'automation-thread-group.png')
    await restoreRunTime()
    await $(`.automation-schedule-runs .chat-row[data-thread-id="${scheduledThreadId}"]`).click()

    const userMessage = $('.msg-user .message-text')
    // Same reasoning as the sibling diagnostic in automation-attention (#1719):
    // "element wasn't found" cannot distinguish a row whose click selected
    // nothing, a thread that opened empty, and a thread whose prompt rendered
    // under a different role. Say which one it is.
    try {
      await expect(userMessage).toHaveText(PROMPT, { wait: 15_000 })
    } catch {
      const [msgCount, userCount, activeThread, transcript] = await Promise.all([
        $$('.msg').length,
        $$('.msg-user').length,
        browser.execute(
          () =>
            document
              .querySelector('.chats-list .chat-row.is-active')
              ?.getAttribute('data-thread-id') ?? '<none active>',
        ),
        browser.execute(() =>
          Array.from(document.querySelectorAll('.msg'))
            .slice(0, 4)
            .map((node) => `${node.className}:${(node.textContent ?? '').slice(0, 60)}`)
            .join(' || '),
        ),
      ])
      throw new Error(
        `the scheduled run's prompt never rendered — ${String(msgCount)} message(s), ` +
          `${String(userCount)} user message(s), active thread ${activeThread}, ` +
          `transcript: ${transcript || '<empty>'}`,
      )
    }

    await scenario.release('review-ready')
    const expectedResponse = 'The CI review is complete; no failures were found.'
    await browser.waitUntil(
      async () => {
        const assistantMessages = await $$('.msg-assistant .message-text')
        for (let i = 0; i < assistantMessages.length; i += 1) {
          if ((await assistantMessages[i]?.getText())?.includes(expectedResponse)) return true
        }
        return false
      },
      {
        timeout: 30_000,
        timeoutMsg: `expected an assistant message containing ${JSON.stringify(expectedResponse)}`,
      },
    )
    assert.equal(await $('.prompt-input').getText(), '')

    const restoreFinalRunTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    try {
      await saveAppScreenshot('automation-trigger.png')
    } finally {
      await restoreFinalRunTime()
    }
  })
})
