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
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import {
  COPSE_TINT_COLOR,
  applyAppearanceViaSettings,
  editorSurfacePaint,
} from './helpers/appearance.ts'
import { assertScheduleHeadingKeepsTitle } from './helpers/text-fit.ts'

const PROJECT_ID = 'e2e-automation-trigger'
const OTHER_PROJECT_ID = 'e2e-automation-trigger-other'
const PROMPT = 'Review CI and report any failures.'
const SCHEDULE_ID = 'schedule-ci-review'

// Start with a disabled schedule so installing the mock scenario cannot race
// a headless boot run. Enable it through the real inactive-project editor and
// wait for its actual next-minute cron occurrence.
const SCHEDULER_TICK_TIMEOUT_MS = 90_000

describe('cron automation trigger', function () {
  // A mock agent turn plus checkout preparation, with headroom for a loaded runner.
  this.timeout(180_000)

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
                enabled: false,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
                lastCreatedThreadId: 'automation-history-latest',
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
                toolCalls: [
                  { name: 'run_shell', args: { command: 'git worktree add ../approval-checkout' } },
                ],
              },
              {
                text: 'The checkout request is waiting for your approval; I completed the review I could do now.',
                expectToolResults: [
                  { name: 'run_shell', includes: 'Queued for review as request' },
                ],
              },
            ],
          },
        ],
      },
      null,
    )
    await applyAppearanceViaSettings({
      theme: 'dark',
      tintColor: COPSE_TINT_COLOR,
      tintStrength: 'strong',
    })

    const setScheduleEnabled = async (): Promise<void> => {
      await $(`.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`).click()
      await $('.context-menu-item=Automations').click()
      const dialog = $('#automation-dialog')
      await dialog.$('.automation-row-btn=Edit').click()
      await dialog.$('.automation-enabled-input').click()
      await dialog.$('.automation-save-btn').click()
      await expect(dialog.$('.automation-form')).not.toBeDisplayed()
      await browser.keys('Escape')
      await expect(dialog).not.toBeDisplayed()
    }
    await setScheduleEnabled()
    // This hold can only be reached by main's unfocused-project path. Do not
    // open the target project until its isolated checkout and dispatch exist.
    await scenario.waitForHold('review-ready', SCHEDULER_TICK_TIMEOUT_MS)
    // Keep later minute boundaries from adding another run after we release
    // this response for the final screenshots.
    await setScheduleEnabled()

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
    assert.equal(await $('.automation-threads-toggle .automation-threads-count').getText(), '1')
    await automationGroup.click()

    // Scheduler updates replace the sidebar subtree. Resolve descendants from
    // their full selector each time instead of retaining a detached parent.
    const scheduleGroupSelector = `.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`
    const scheduleGroup = $(scheduleGroupSelector)
    await scheduleGroup.waitForExist({ timeout: 5_000 })
    assert.equal(
      await $(`${scheduleGroupSelector} .automation-schedule-title`).getText(),
      'CI review',
    )
    await browser.waitUntil(
      async () =>
        (await $(`${scheduleGroupSelector} .automation-schedule-count`).getText()) === '3 runs',
      {
        timeout: SCHEDULER_TICK_TIMEOUT_MS,
        timeoutMsg:
          'the fresh scheduled task never joined its existing schedule group — the persisted ' +
          'scheduler task should have fired its next-minute tick',
      },
    )
    // Finish checkout/provider startup, then hold the response while opening
    // the scheduled run. Streaming store updates rebuild the entire sidebar
    // and can detach a row between WebDriver locating and clicking it.
    await scenario.waitForHold('review-ready')
    assert.equal(await $(`${scheduleGroupSelector} .automation-schedule-count`).getText(), '3 runs')
    assert.equal(
      await $(`${scheduleGroupSelector} .automation-schedule-toggle`).getAttribute('aria-expanded'),
      'false',
    )
    await $(`${scheduleGroupSelector} .automation-schedule-toggle`).click()

    const scheduledRow = $(`${scheduleGroupSelector} .automation-schedule-runs .chat-row`)
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
    await assertScheduleHeadingKeepsTitle(
      `.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`,
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
            .map((node) => `${node.className}:${node.textContent.slice(0, 60)}`)
            .join(' || '),
        ),
      ])
      throw new Error(
        `the scheduled run's prompt never rendered — ${String(msgCount)} message(s), ` +
          `${String(userCount)} user message(s), active thread ${activeThread}, ` +
          `transcript: ${transcript || '<empty>'}`,
      )
    }

    await browser.waitUntil(
      () => browser.execute(() => document.documentElement.hasAttribute('data-automation-active')),
      {
        timeout: 10_000,
        timeoutMsg: 'a running scheduled thread never enabled automation appearance mode',
      },
    )
    assert.equal(await browser.execute(() => document.documentElement.dataset['theme']), 'dark')
    assert.equal(
      await browser.execute(() => document.documentElement.dataset['tintPalette']),
      'copse',
    )
    assert.equal(
      await browser.execute(() => document.documentElement.dataset['tintStrength']),
      'strong',
    )
    assert.deepEqual((await editorSurfacePaint([])).token, [45, 39, 26])
    const restoreActiveRunTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    // This checkout was allocated by the real scheduler, so its branch embeds
    // a fresh thread id. Assert the real branch before pinning only its label.
    await expect($('.footer-branch-label')).toHaveText(/^copse\/thread-[a-f0-9]+$/)
    const restoreActiveBranch = await pinTextForCapture(
      '.footer-branch-label',
      /^copse\/thread-[a-f0-9]+$/,
      'copse/thread-000001',
    )
    try {
      await saveAppScreenshot('automation-active.png')
    } finally {
      await restoreActiveBranch()
      await restoreActiveRunTime()
    }

    await scenario.release('review-ready')
    const expectedResponse =
      'The checkout request is waiting for your approval; I completed the review I could do now.'
    await browser.waitUntil(
      async () => {
        const assistantMessages = await $$('.msg-assistant .message-text').getElements()
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
    await scenario.assertComplete()
    await expect($('.tool-card[data-status="error"]')).toBeExisting()
    await expect($('#approval-dialog')).not.toBeDisplayed()
    assert.equal(
      existsSync(join(dirname(process.env['COPSE_WORKTREES_DIR'] ?? ''), 'approval-checkout')),
      false,
    )
    const restoreRequestId = await pinTextForCapture(
      '#app',
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      '00000000-0000-0000-0000-000000000000',
    )
    await browser.waitUntil(
      () => browser.execute(() => !document.documentElement.hasAttribute('data-automation-active')),
      {
        timeout: 10_000,
        timeoutMsg: 'automation appearance mode did not restore after the scheduled run settled',
      },
    )
    assert.deepEqual((await editorSurfacePaint([])).token, [0, 46, 43])
    await expect($(`${scheduleGroupSelector} .automation-schedule-held`)).toHaveText('1 held')

    const restoreFinalRunTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    // The completed turn names its branch after the CI review. Wait for that
    // real rename before replacing the remaining generated id for capture.
    await expect($('.footer-branch-label')).toHaveText(/^copse\/ci-review-[a-f0-9]+$/)
    const restoreFinalBranch = await pinTextForCapture(
      '.footer-branch-label',
      /^copse\/ci-review-[a-f0-9]+$/,
      'copse/ci-review-000001',
    )
    try {
      await expect($('.apple-development-error')).not.toExist()
      await saveAppScreenshot('automation-trigger.png')
      if (!(await $('#pane-files').isDisplayed()))
        await $('[aria-label="Toggle right panel"]').click()
      await $('[aria-label="Open thread context"]').click()
      await expect($('[data-context-section="requests"]')).toBeDisplayed()
      await expect($('[data-context-section="requests"] [data-deferred-approval-id]')).toExist()
      await expect($('[data-context-section="requests"]')).toHaveText(
        expect.stringContaining('Not run'),
      )
      await expect($('[data-context-change-stats]')).not.toHaveText('Calculating…')
      const restoreContextBranch = await pinTextForCapture(
        '.thread-context-repo .thread-context-meta',
        /^Worktree · copse\/ci-review-[a-f0-9]+$/,
        'Worktree · copse/ci-review-000001',
      )
      try {
        await saveElementScreenshot('#pane-files', 'automation-deferred-context.png')
      } finally {
        await restoreContextBranch()
      }
    } finally {
      await restoreFinalBranch()
      await restoreFinalRunTime()
      await restoreRequestId()
    }
  })
})
