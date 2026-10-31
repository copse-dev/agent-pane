import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  e2eWorkspaceDir,
  resetUserData,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const activeProject = 'e2e-activity-open'
const unopenedProject = 'e2e-activity-unopened'
let root = ''

describe('unopened-project metadata redraws Activity at startup', () => {
  before(async function () {
    this.timeout(120_000)
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === 'complete',
    )
    root = mkdtempSync(join(tmpdir(), 'copse-unopened-activity-'))
    const open = join(root, 'open')
    const unopened = join(root, 'unopened')
    mkdirSync(open)
    mkdirSync(unopened)
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [
        { id: activeProject, name: 'open-project', path: open },
        { id: unopenedProject, name: 'unopened-project', path: unopened },
      ],
      activeProjectId: activeProject,
      expandedProjectId: activeProject,
      activeThreadId: 'e2e-activity-blank',
      [`threads:${activeProject}`]: [
        {
          id: 'e2e-activity-blank',
          title: 'New Thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
      [`threads:${unopenedProject}`]: [
        {
          id: 'e2e-activity-completed',
          title: 'Unopened release notes',
          status: 'idle',
          unreadAt: now,
          lastPromptAt: now - 10,
          messages: [
            {
              id: 'release-user',
              role: 'user',
              content: 'Write release notes',
              createdAt: now - 10,
            },
            {
              id: 'release-answer',
              role: 'assistant',
              content: 'Release notes are ready.',
              createdAt: now,
            },
          ],
          usage: { inputTokens: 12, outputTokens: 5 },
          createdAt: now - 10,
          updatedAt: now,
        },
      ],
    })
    writeSettings({
      theme: 'dark',
      sidebarThreadGroup: 'status',
      windowBounds: { width: 1600, height: 900 },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (root) removeE2eTree(root)
  })

  for (const width of [800, 1600]) {
    it(`shows the unopened completion without switching projects at ${String(width)}px`, async function () {
      this.timeout(60_000)
      const row = $('#activity-home .activity-row[data-thread-id="e2e-activity-completed"]')
      await row.waitForDisplayed({ timeout: 30_000 })
      await expect(row.$('.activity-thread')).toHaveText('Unopened release notes')
      await expect(row.$('.activity-state')).toHaveText('Done')
      expect(await browser.execute(() => window.api.storage.get('activeProjectId'))).toBe(
        activeProject,
      )
      await expect($('.prompt-input')).toBeDisplayed()
      // The capture frame holds the focused composer's caret steady: a blinking
      // one is drawn in some captures and not others.
      await saveAppScreenshot(`sidebar-unopened-activity-${String(width)}.png`, {
        width,
        height: 900,
      })
    })
  }
})

describe('status sidebar title and details', () => {
  before(async function () {
    this.timeout(120_000)
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === 'complete',
    )
    // Close the outgoing stores before removing the preceding fixture's projects.
    // Resetting config alone makes their retained threads appear as recoverable.
    await browser.deleteSession({ shutdownDriver: false })
    for (const projectId of [activeProject, unopenedProject]) {
      removeE2eTree(join(e2eWorkspaceDir(), projectId))
    }
    root = mkdtempSync(join(tmpdir(), 'copse-status-details-'))
    const projectPath = join(root, 'project')
    mkdirSync(projectPath)
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: 'status-project', name: 'copse-panel', path: projectPath }],
      activeProjectId: 'status-project',
      expandedProjectId: 'status-project',
      activeThreadId: 'status-hour',
      'threads:status-project': [
        {
          id: 'status-hour',
          title: 'Make the status sidebar easier to scan',
          status: 'idle',
          messages: [
            {
              id: 'seed-request',
              role: 'user',
              content: 'Review the sidebar layout.',
              createdAt: now - 86_400_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now - 3_600_000,
          updatedAt: now,
        },
        {
          id: 'status-day',
          title: 'Review yesterday’s release notes',
          status: 'idle',
          messages: [
            {
              id: 'seed-request',
              role: 'user',
              content: 'Review the sidebar layout.',
              createdAt: now - 86_400_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now - 86_400_000,
          updatedAt: now,
        },
      ],
    })
    writeSettings({
      theme: 'dark',
      sidebarThreadGroup: 'project',
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('switches through Group by Status and puts creation age and project beneath the title', async function () {
    this.timeout(60_000)
    await $('.projects-sort-btn').waitForDisplayed({ timeout: 30_000 })
    await $('.projects-sort-btn').click()
    const status = await browser.$('.context-menu-item=Status')
    await status.click()
    const row = $('.chat-row[data-thread-id="status-hour"]')
    await expect(row.$('.chat-thread-age')).toHaveText('1h')
    await expect(row.$('.chat-thread-owner')).toHaveText('· copse-panel')
    await expect($('.chat-row[data-thread-id="status-day"] .chat-thread-age')).toHaveText('1d')
    const geometry = await browser.execute(() => {
      const row = document.querySelector('.chat-row[data-thread-id="status-hour"]')
      const title = row?.querySelector('.chat-title')?.getBoundingClientRect()
      const details = row?.querySelector('.chat-thread-details')?.getBoundingClientRect()
      if (!title || !details) throw new Error('Missing title or details')
      return {
        titleBottom: title.bottom,
        detailsTop: details.top,
        titleLeft: title.left,
        detailsLeft: details.left,
        titleWidth: title.width,
        detailsWidth: details.width,
      }
    })
    expect(geometry.detailsTop).toBeGreaterThanOrEqual(geometry.titleBottom)
    expect(geometry.titleLeft).toBe(geometry.detailsLeft)
    expect(Math.abs(geometry.titleWidth - geometry.detailsWidth)).toBeLessThan(1)
    await expect($('.orphans-heading')).not.toExist()
    await saveAppScreenshot('sidebar-status-details.png')
    await row.$('.chat-title').doubleClick()
    await expect(row.$('.chat-title-rename')).toBeDisplayed()
    await expect(row.$('.chat-thread-details')).toBeDisplayed()
    await browser.keys('Escape')
  })
})
