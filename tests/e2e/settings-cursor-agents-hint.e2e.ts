import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { $, browser, expect } from '@wdio/globals'
import { CURSOR_AGENTS_WEB_URL } from '../../src/shared/remote-agent.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'
import { assertKitButtonChrome } from './helpers/ui-kit-style.ts'
import { assertLegendInsideCard } from './helpers/settings-geometry.ts'

describe('Cursor Cloud Agent settings list hint', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Make fresh-install consent deterministic across host CLI installations.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: (process.platform === 'win32'
        ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
        : ['/usr/bin', '/bin']
      ).join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-settings-cursor-agents-hint', {
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true },
      ],
    })
    // The Cursor cloud agent is set up under a saved Cursor API key.
    writeSettings({
      ...readSeededSettings(),
      apiKey: {
        cursor: { v: 1, enc: Buffer.from('cur_e2e', 'utf8').toString('base64'), plain: true },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('explains Filter → Source → API and links to cursor.com/agents', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const general = $('.settings-section[data-section="general"]')
    await expect(general).toBeDisplayed()

    // The Cursor cloud agent lives under the saved Cursor key's Options; open
    // them, then scroll the block into view so the sticky footer does not
    // cover the hint.
    const cursorKey = general.$('[data-testid="models-agents-list"] [data-row="key:cursor"]')
    await cursorKey.waitForExist({ timeout: 15_000 })
    await cursorKey.$('button=Options').click()

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="cursor-agents-list-hint"]')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'center' })
    })

    const hint = general.$('[data-testid="cursor-agents-list-hint"]')
    await expect(hint).toBeDisplayed()
    const text = await hint.getText()
    assert.match(text, /Filter → Source → API/)
    assert.match(text, /cursor\.com\/agents/)

    const link = hint.$('a')
    await expect(link).toHaveAttribute('href', CURSOR_AGENTS_WEB_URL)
    await expect(link).toHaveAttribute('target', '_blank')

    // The nested auth card's title sits inside the card, not on its top edge.
    await assertLegendInsideCard('Cursor authentication')
    await hint.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#settings-dialog', 'settings-cursor-agents-hint.png')

    // Cursor is not installed on this PATH, so it is offered under Add an agent
    // with a copyable install command.
    await $('[data-testid="connections-add-toggle"]').click()
    const addRow = $('.acp-add-row[data-agent="cursor"]')
    await expect(addRow).toBeDisplayed()
    await assertKitButtonChrome('.acp-add-row[data-agent="cursor"] button', 'secondary')
    const approval = $('#approval-dialog')
    await expect(approval).not.toBeDisplayed()
  })
})
