import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'

describe('project quarantine and orphan recovery', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [
        { id: 'healthy', path: process.cwd(), name: 'Healthy project' },
        {
          id: 'missing',
          path: '/volumes/archive/moved-project',
          name: 'Moved project',
          missing: true,
        },
      ],
      activeProjectId: 'healthy',
      'threads:healthy': [],
      'threads:orphan-store': [
        {
          id: 'orphan-thread',
          title: 'Recovered planning notes',
          status: 'idle',
          messages: [
            {
              id: 'orphan-message',
              role: 'user',
              content: 'Keep this thread recoverable.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows preserved missing projects and recoverable orphan threads', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const missingRow = await $('.project-row.missing')
    await missingRow.waitForDisplayed({ timeout: 15_000 })
    await expect(missingRow.$('.project-name')).toHaveText('Moved project')
    assert.match((await missingRow.getAttribute('title')) ?? '', /folder missing/i)

    await missingRow.click()
    const notice = await $('.project-missing-notice')
    await notice.waitForDisplayed({ timeout: 10_000 })
    await expect(notice.$('.project-missing-text')).toHaveText(
      'This folder could not be opened. Its threads are safe — relocate the project to restore them.',
    )
    await expect(notice.$('.project-missing-btn')).toHaveText('Relocate…')

    const orphanSection = await $('.orphans-section')
    await orphanSection.waitForDisplayed({ timeout: 15_000 })
    await expect(orphanSection.$('.orphans-heading')).toHaveText('Recoverable threads')
    await expect(orphanSection.$('.orphan-name')).toHaveText('1 thread')
    await expect(orphanSection.$('.orphan-recover-btn')).toHaveText('Recover…')

    await saveElementScreenshot('#pane-projects', 'project-quarantine-recovery.png')
  })
})
