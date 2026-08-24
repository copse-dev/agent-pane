import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-settings-sources-agents'
const AGENT_NAME = 'security-reviewer'
const AGENT_DESCRIPTION = 'Reviews authentication changes for security regressions.'

describe('custom agent discovery surfaces', () => {
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-sources-agents-'))
    const agentsDir = join(workspaceRoot, '.cursor', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, `${AGENT_NAME}.md`),
      [
        '---',
        `name: ${AGENT_NAME}`,
        `description: ${AGENT_DESCRIPTION}`,
        'model: opus',
        'tools: Read, Grep',
        '---',
        '',
        'Review the requested changes and report concrete security risks.',
        '',
      ].join('\n'),
      'utf8',
    )

    seedEmptyProject(workspaceRoot, PROJECT_ID, { developerMode: true })
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

  it('shows a project agent in Settings and the slash-command picker', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const agentsList = dialog.$('#sources-agents-list')
    await browser.waitUntil(async () => (await agentsList.getText()).includes(AGENT_NAME), {
      timeout: 15_000,
      timeoutMsg: `expected ${AGENT_NAME} in Settings → Sources → Agents`,
    })
    const text = await agentsList.getText()
    assert.match(text, new RegExp(AGENT_NAME))
    assert.match(text, new RegExp(AGENT_DESCRIPTION))
    assert.match(text, /project/i)
    assert.match(text, /\.cursor/i)

    await browser.execute(() => {
      document.querySelector('#sources-agents-list')?.closest('fieldset')?.scrollIntoView({
        block: 'start',
      })
    })
    await saveElementScreenshot('fieldset:has(#sources-agents-list)', 'settings-sources-agents.png')

    await dialog.$('#settings-close').click()
    await browser.waitUntil(async () => !(await dialog.isDisplayed()), { timeout: 5_000 })
    await setComposerValue(`/${AGENT_NAME}`)

    const picker = $('.skill-picker')
    await picker.waitForDisplayed({ timeout: 10_000 })
    const row = picker.$(`.skill-item*=${AGENT_NAME}`)
    await expect(row.$('.skill-item-name')).toHaveText(`/${AGENT_NAME}`, { containing: true })
    await expect(row.$('.skill-item-kind')).toHaveText('agent')
    await expect(row.$('.skill-item-desc')).toHaveText(AGENT_DESCRIPTION)
    await saveAppScreenshot('custom-agent-slash-picker.png')
  })
})
