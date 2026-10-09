import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, savePreparedAppScreenshot } from './helpers/screenshot.ts'

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
    if (root) rmSync(root, { recursive: true, force: true })
  })

  for (const width of [800, 1600]) {
    it(`shows the unopened completion without switching projects at ${String(width)}px`, async function () {
      this.timeout(60_000)
      await prepareE2eScreenshot({ width, height: 900 })
      const row = $('#activity-home .activity-row[data-thread-id="e2e-activity-completed"]')
      await row.waitForDisplayed({ timeout: 30_000 })
      await expect(row.$('.activity-thread')).toHaveText('Unopened release notes')
      await expect(row.$('.activity-state')).toHaveText('Done')
      expect(await browser.execute(() => window.api.storage.get('activeProjectId'))).toBe(
        activeProject,
      )
      await expect($('.prompt-input')).toBeDisplayed()
      await savePreparedAppScreenshot(`sidebar-unopened-activity-${String(width)}.png`)
    })
  }
})
