import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

process.env['COPSE_PANEL_MOCK_LLM'] = '1'
process.env['ANTHROPIC_API_KEY'] = ''
process.env['OPENAI_API_KEY'] = ''

const PROJECT_ID = 'e2e-settings-sources-nested-instructions'

describe('settings sources nested AGENTS.md (#1354)', function () {
  this.timeout(90_000)
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-nested-instructions-'))
    mkdirSync(join(workspaceRoot, 'packages', 'api', 'src'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'packages', 'web', 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), 'Root workspace conventions.\n', 'utf8')
    writeFileSync(
      join(workspaceRoot, 'packages', 'api', 'AGENTS.md'),
      'API package conventions.\n',
      'utf8',
    )
    writeFileSync(
      join(workspaceRoot, 'packages', 'web', 'AGENTS.md'),
      'Web package conventions.\n',
      'utf8',
    )

    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      trustedWorkspaceRoots: [realpathSync(workspaceRoot)],
      [`threads:${PROJECT_ID}`]: [],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows active and inactive directory scopes after a path activates one branch', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('Review packages/api/src/router.ts and explain its role.')
    await $('.submit-btn').click()
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })
    await waitForAgentIdle(30_000)

    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()
    const list = dialog.$('#sources-instructions-list')
    await browser.waitUntil(
      async () => {
        const text = await list.getText()
        return text.includes('packages/api/AGENTS.md') && text.includes('packages/web/AGENTS.md')
      },
      { timeout: 15_000, timeoutMsg: 'expected both nested AGENTS.md sources' },
    )

    const apiRow = list.$('.sources-row*=packages/api/AGENTS.md')
    const webRow = list.$('.sources-row*=packages/web/AGENTS.md')
    await expect(apiRow.$('.sources-badge')).toHaveText('active', { ignoreCase: true })
    await expect(webRow.$('.sources-badge')).toHaveText('scoped', { ignoreCase: true })
    assert.match(await apiRow.$('.sources-row-detail').getText(), /scope: packages\/api\//)
    assert.match(await apiRow.$('.sources-row-detail').getText(), /active this turn/)
    assert.match(
      await webRow.$('.sources-row-detail').getText(),
      /activates when a path under this directory enters context/,
    )

    await browser.execute(() => {
      const rows = document.querySelectorAll<HTMLElement>('#sources-instructions-list .sources-row')
      for (const row of rows) {
        const detail = row.querySelector<HTMLElement>('.sources-row-detail')
        if (!detail?.textContent) continue
        const parts = detail.textContent.split(' · ')
        parts[0] = `<workspace>/${row.querySelector('.sources-row-title')?.textContent ?? ''}`
        detail.textContent = parts.join(' · ')
      }
      document
        .querySelector('#sources-instructions-list')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'start' })
    })
    await saveElementScreenshot(
      'fieldset:has(#sources-instructions-list)',
      'settings-sources-nested-instructions.png',
    )
  })
})
