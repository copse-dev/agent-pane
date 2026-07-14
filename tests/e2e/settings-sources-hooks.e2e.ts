import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-sources-hooks'

describe('settings sources hooks (Claude Code)', () => {
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-claude-hooks-'))
    mkdirSync(join(workspaceRoot, '.claude'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: './hooks/block-destructive.sh' }],
            },
          ],
        },
      }),
      'utf8',
    )

    const trustedRoot = realpathSync(workspaceRoot)
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    // Re-write config to add trust so project Claude hooks appear in Sources.
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      trustedWorkspaceRoots: [trustedRoot],
      [`threads:${PROJECT_ID}`]: [],
    })

    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists Claude Code PreToolUse hooks in Settings → Sources', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="sources"]').click()

    const sources = dialog.$('.settings-section[data-section="sources"]')
    await expect(sources).toBeDisplayed()
    await expect(sources.$('legend=Hooks')).toBeDisplayed()

    const hooksList = sources.$('#sources-hooks-list')
    await browser.waitUntil(
      async () => {
        const text = await hooksList.getText()
        return text.includes('PreToolUse') && text.includes('Claude Code')
      },
      { timeout: 15_000, timeoutMsg: 'expected Claude PreToolUse hook in Sources' },
    )

    const text = await hooksList.getText()
    assert.match(text, /PreToolUse · Bash/)
    assert.match(text, /Claude Code/)
    assert.match(text, /block-destructive\.sh/)
    assert.match(text, /project/)

    await saveElementScreenshot(
      '.settings-section[data-section="sources"]',
      'settings-sources-claude-hooks.png',
    )
  })
})
