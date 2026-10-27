import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
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
