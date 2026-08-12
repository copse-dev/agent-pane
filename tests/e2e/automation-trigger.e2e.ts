import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-trigger'
const PROMPT = 'Review CI and report any failures.'
const SCHEDULE_ID = 'schedule-ci-review'

// The schedule's own `* * * * *` is not what paces this spec. `automation-
// service.start()` enqueues its tick as a supervised cron task, and
// `TaskSupervisor.arm()` sets that timer to `nextCronOccurrence(…)` — the next
// *minute boundary*. So the first tick lands 0-60s after the app boots,
// uniformly distributed, and only then does `tick()` match the schedule and
// create the thread.
//
// The wait here was 30s, which meant this spec failed whenever the app happened
// to start more than 30s before the boundary — roughly half of all runs, and
// invisibly so, because `ci.yml` skips e2e on pushes to main.
const SCHEDULER_BOUNDARY_WAIT_MS = 75_000

describe('cron automation trigger', function () {
  // The boundary wait plus a mock agent turn, with headroom for a loaded runner.
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
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('submits the scheduled prompt and completes a real mock agent turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const automationGroup = $('.automation-threads-toggle')
    await automationGroup.waitForExist({
      timeout: SCHEDULER_BOUNDARY_WAIT_MS,
      timeoutMsg: `the scheduled automation group never appeared within ${String(
        SCHEDULER_BOUNDARY_WAIT_MS,
      )}ms — the supervisor arms its tick for the next minute boundary, so this must outlast a full minute`,
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
        timeout: SCHEDULER_BOUNDARY_WAIT_MS,
        timeoutMsg: 'the fresh scheduled task never joined its existing schedule group',
      },
    )
    assert.equal(await scheduleGroup.$('.automation-schedule-count').getText(), '3 runs')
    assert.equal(
      await scheduleGroup.$('.automation-schedule-toggle').getAttribute('aria-expanded'),
      'false',
    )
    await scheduleGroup.$('.automation-schedule-toggle').click()

    const scheduledRow = scheduleGroup.$('.automation-schedule-runs .chat-row')
    await scheduledRow.waitForExist({ timeout: 5_000 })
    assert.match(await scheduledRow.getText(), /^Latest · /)
    await saveElementScreenshot('.automation-threads-group', 'automation-thread-group.png')
    await scheduledRow.click()

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

    const expectedResponse = `Mock response to: ${PROMPT}`
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

    await saveAppScreenshot('automation-trigger.png')
  })
})
