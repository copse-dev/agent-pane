import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-attention'
const SCHEDULE_ID = 'schedule-ci-review-attention'
const ASK_PROMPT =
  '[[mcp:ask_user {"questions":[{"question":"Which CI failure should I investigate?","options":["Latest failure","All failures"]}]}]]'

describe('automation attention grouping', function () {
  // The attention wait below is 75s on its own — see the comment there. The
  // rest of the spec then drives a reveal, an expand, and an ask_user dialog.
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
    // Keep what `runNow` answered. It reports whether the schedule was found at
    // all, which is the first fork in the diagnosis below — and the old code
    // awaited it only to discard it.
    const runNowResult = await browser.execute(
      async ([projectId, scheduleId]) => {
        const host = window as unknown as {
          api?: {
            automations?: { runNow?: (project: string, schedule: string) => Promise<unknown> }
          }
        }
        if (!host.api?.automations?.runNow) throw new Error('automations.runNow unavailable')
        return await host.api.automations.runNow(projectId, scheduleId)
      },
      [PROJECT_ID, SCHEDULE_ID],
    )

    const automationToggle = $('.automation-threads-toggle')
    // This wait is not for a render — it is for a whole agent turn (#1719).
    //
    // `automationExpanded` in projects-pane.ts is true here only because
    // `attentionAutomationThreads.length > 0`; no other term in that expression
    // applies to a freshly booted profile with nothing active. So the reveal
    // cannot happen until the run `runNow` just started has allocated its
    // worktree, spawned its task, run a mock turn, and reached the `ask_user`
    // gate that raises attention. `runNow` resolves as soon as the run is
    // *started*, so awaiting it covers none of that.
    //
    // 30s did not cover it on a contended runner, which is why this spec was
    // intermittent rather than broken: it passed whenever the turn happened to
    // land inside the budget. The diagnostics below caught a failing instance
    // on run 31408123933 and reported `runNow` returning
    // `{"disposition":"started",…}` with a real thread id, the toggle present
    // at `aria-expanded=false`, and **0 attention bells** — a run under way
    // that had not yet asked anything.
    //
    // 75s matches `automation-trigger`, which had the same class of bug and
    // documents its own boundary maths; the mocha budget above rises with it.
    //
    // The diagnostics stay. They are what turned this from a fourth guess into
    // a measurement, and they cost nothing on the passing path.
    try {
      await browser.waitUntil(
        async () => (await automationToggle.getAttribute('aria-expanded')) === 'true',
        { timeout: 75_000 },
      )
    } catch {
      const [toggleExists, expanded, groupCount, rowCount, bellCount, titles] = await Promise.all([
        automationToggle.isExisting(),
        automationToggle.getAttribute('aria-expanded').catch(() => '<unreadable>'),
        $$('.automation-schedule-group').length,
        $$('.chats-list .chat-row').length,
        $$('.chat-attention-bell').length,
        browser.execute(() =>
          Array.from(document.querySelectorAll('.chats-list .chat-title'))
            .map((node) => node.textContent ?? '')
            .join(' | '),
        ),
      ])
      throw new Error(
        'attention did not reveal the Automations group — ' +
          `runNow returned ${JSON.stringify(runNowResult)}, ` +
          `.automation-threads-toggle ${toggleExists ? 'exists' : 'is ABSENT'} ` +
          `with aria-expanded=${String(expanded)}, ` +
          `${String(groupCount)} schedule group(s), ${String(rowCount)} sidebar row(s), ` +
          `${String(bellCount)} attention bell(s), titles: ${titles || '<none>'}`,
      )
    }
    assert.equal((await automationToggle.$$('.chat-attention-bell')).length, 0)

    const scheduleGroup = $(`.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`)
    await scheduleGroup.waitForExist({ timeout: 5_000 })
    await expect(scheduleGroup.$('.automation-schedule-count')).toHaveText('4 runs')
    assert.equal(
      (await scheduleGroup.$$('.automation-schedule-toggle .chat-attention-bell')).length,
      0,
    )
    assert.equal(
      await scheduleGroup.$('.automation-schedule-toggle').getAttribute('aria-expanded'),
      'false',
    )

    const visibleRuns = scheduleGroup.$$('.automation-schedule-runs .chat-row')
    await browser.waitUntil(async () => (await visibleRuns).length === 1, {
      timeout: 5_000,
      timeoutMsg: 'attention reveal should hide older automation runs',
    })
    const waitingRun = (await visibleRuns)[0]
    assert.ok(waitingRun)
    await expect(waitingRun.$('.chat-attention-bell')).toBeDisplayed()
    await saveElementScreenshot('.automation-threads-group', 'automation-attention-group.png')

    const waitingThreadId = await waitingRun.getAttribute('data-thread-id')
    assert.ok(waitingThreadId)
    await scheduleGroup.$('.automation-schedule-toggle').click()
    await expect(scheduleGroup.$('.automation-schedule-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    assert.equal((await scheduleGroup.$$('.automation-schedule-runs .chat-row')).length, 4)
    await scheduleGroup.$(`.chat-row[data-thread-id="${waitingThreadId}"]`).click()
    const askDialog = $('#ask-user-dialog')
    await askDialog.waitForDisplayed({ timeout: 10_000 })
    await askDialog.$('.ask-user-cancel').click()
  })
})
