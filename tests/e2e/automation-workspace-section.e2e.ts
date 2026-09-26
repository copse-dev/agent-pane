import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_A_ID = 'e2e-automation-workspace-a'
const PROJECT_B_ID = 'e2e-automation-workspace-b'
const SCHEDULE_A_ID = 'schedule-workspace-docs'
const SCHEDULE_B_ID = 'schedule-workspace-ops'

/**
 * Collating automations under one workspace-level heading (#2511) instead of
 * inside each project. Automation data stays strictly project-owned
 * (`AutomationSchedule.projectId`), and the sidebar only has thread data for
 * the active project plus whatever a background project was switched to
 * earlier this session (`getSidebarThreads`, projects.ts) — so the spec
 * visits project B once before asserting both schedules are collated.
 */
describe('workspace-level automations section', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    writeSeedConfig({
      projects: [
        { id: PROJECT_A_ID, path: workspaceRoot, name: 'Docs project' },
        { id: PROJECT_B_ID, path: workspaceRoot, name: 'Ops project' },
      ],
      activeProjectId: PROJECT_A_ID,
      activeThreadId: 'a-chat',
      [`threads:${PROJECT_A_ID}`]: [
        {
          id: 'a-chat',
          title: 'Release planning',
          status: 'idle',
          messages: [
            {
              id: 'a-chat-message',
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
        {
          id: 'a-docs-run',
          title: 'Docs freshness',
          status: 'idle',
          messages: [
            {
              id: 'a-docs-run-answer',
              role: 'assistant',
              content: 'The docs match the code.',
              toolCalls: [],
              createdAt: 1_786_000_180_000,
            },
          ],
          usage: { inputTokens: 100, outputTokens: 25 },
          automation: {
            scheduleId: SCHEDULE_A_ID,
            scheduleName: 'Docs freshness',
            triggeredAt: 1_786_000_120_000,
          },
          createdAt: 1_786_000_120_000,
          updatedAt: 1_786_000_180_000,
        },
      ],
      [`threads:${PROJECT_B_ID}`]: [
        {
          id: 'b-ops-run',
          title: 'Ops review',
          status: 'idle',
          messages: [
            {
              id: 'b-ops-run-answer',
              role: 'assistant',
              content: 'Nothing needs attention.',
              toolCalls: [],
              createdAt: 1_785_913_780_000,
            },
          ],
          usage: { inputTokens: 90, outputTokens: 20 },
          automation: {
            scheduleId: SCHEDULE_B_ID,
            scheduleName: 'Ops review',
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
                id: SCHEDULE_A_ID,
                projectId: PROJECT_A_ID,
                name: 'Docs freshness',
                cron: '0 9 * * 1-5',
                prompt: 'Check the docs against the code and report anything stale.',
                model: 'claude-sonnet-4-6',
                // Production scheduling stays live during e2e; keep both paused.
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
              },
              {
                id: SCHEDULE_B_ID,
                projectId: PROJECT_B_ID,
                name: 'Ops review',
                cron: '0 8 * * 1-5',
                prompt: 'Review overnight alerts and summarise anything actionable.',
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: 1_785_913_000_000,
                updatedAt: 1_785_913_000_000,
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

  it('collates every visited project’s automations under the workspace heading', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const toggle = $('.automation-threads-toggle')
    await toggle.waitForExist({ timeout: 15_000 })
    // Project B has not been visited this session, so only A's schedule is
    // known yet — the same limit a collapsed, never-opened project already had.
    await expect(toggle.$('.automation-threads-count')).toHaveText('1')

    // Visiting B loads its real thread history (and automation run) into the
    // sidebar; switching back to A keeps the rest of the screenshot familiar.
    await $('.project-row*=Ops project').click()
    await browser.waitUntil(
      async () => (await toggle.$('.automation-threads-count').getText()) === '2',
      { timeout: 15_000, timeoutMsg: 'Ops project’s schedule never joined the workspace section' },
    )
    await $('.project-row*=Docs project').click()
    await expect(toggle.$('.automation-threads-count')).toHaveText('2')

    const alignment = await browser.execute(() => {
      const automationArrow = document.querySelector('.automation-threads-twisty')
      const automationTitle = document.querySelector('.automation-threads-title')
      const projectArrow = document.querySelector('.project-twisty')
      const projectTitle = document.querySelector('.project-name')
      const automationGroup = document.querySelector('.automation-threads-group')
      const projectsHeader = document.querySelector('.pane-projects-header')
      if (
        !automationArrow ||
        !automationTitle ||
        !projectArrow ||
        !projectTitle ||
        !automationGroup ||
        !projectsHeader
      ) {
        return null
      }
      return {
        arrowOffset:
          automationArrow.getBoundingClientRect().left - projectArrow.getBoundingClientRect().left,
        titleOffset:
          automationTitle.getBoundingClientRect().left - projectTitle.getBoundingClientRect().left,
        automationTopBorder: getComputedStyle(automationGroup).borderTopWidth,
        headerBottomBorder: getComputedStyle(projectsHeader).borderBottomWidth,
      }
    })
    assert.ok(alignment)
    assert.ok(Math.abs(alignment.arrowOffset) < 1, 'automation and project arrows should align')
    assert.ok(Math.abs(alignment.titleOffset) < 1, 'automation and project titles should align')
    assert.equal(alignment.automationTopBorder, '0px')
    assert.equal(alignment.headerBottomBorder, '1px')

    const scaledTitleOffset = await browser.execute(() => {
      const root = document.documentElement
      const previousScale = root.style.getPropertyValue('--ui-scale')
      root.style.setProperty('--ui-scale', '1.25')
      const automationTitle = document.querySelector('.automation-threads-title')
      const projectTitle = document.querySelector('.project-name')
      const offset =
        automationTitle && projectTitle
          ? automationTitle.getBoundingClientRect().left - projectTitle.getBoundingClientRect().left
          : null
      root.style.setProperty('--ui-scale', previousScale)
      return offset
    })
    assert.ok(scaledTitleOffset !== null)
    assert.ok(Math.abs(scaledTitleOffset) < 1, 'titles should also align at 125% interface scale')
    await saveElementScreenshot('.pane-projects', 'automation-workspace-sidebar.png')

    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()

    const rows = $$('.automation-thread-rows .chat-row')
    await browser.waitUntil(async () => (await rows).length === 2, {
      timeout: 5_000,
      timeoutMsg: 'expected both projects’ automation rows once expanded',
    })

    const collated = await browser.execute(() =>
      Array.from(document.querySelectorAll('.automation-thread-rows .chat-row')).map((row) => ({
        title: row.querySelector('.chat-title')?.textContent ?? '',
        owner: row.querySelector('.chat-thread-owner')?.textContent ?? '',
      })),
    )
    assert.deepEqual(collated, [
      { title: 'Docs freshness', owner: '· Docs project' },
      { title: 'Ops review', owner: '· Ops project' },
    ])

    // Not duplicated inside either project's own (collapsed) thread list.
    assert.equal((await $$('.project-entry .chats-list .chat-row.is-automation')).length, 0)

    await saveElementScreenshot('.automation-threads-group', 'automation-workspace-section.png')

    // Each row still carries its own way into the in-place editor, scoped to
    // its own project. `collated` above already proved index 1 is "Ops
    // review", owned by project B.
    const opsRow = (await rows)[1]
    assert.ok(opsRow)
    await opsRow.$('.automation-setup-btn').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog.$('.automation-scope')).toHaveText(
      expect.stringContaining('Project: Ops project'),
    )
    // Opening a background project's setup must not move the active project.
    await expect($('.project-row.active')).toHaveText(expect.stringContaining('Docs project'))
    await dialog.$('[aria-label="Close automations"]').click()
  })
})
