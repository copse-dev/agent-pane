import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-sources-cursor-rules'

describe('settings sources cursor rules (#636)', () => {
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-cursor-rules-'))
    writeFileSync(
      join(workspaceRoot, 'AGENTS.md'),
      'Use the project-specific release checklist before shipping.\n',
      'utf8',
    )
    mkdirSync(join(workspaceRoot, '.cursor', 'rules'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.cursor', 'rules', 'always.mdc'),
      '---\nalwaysApply: true\n---\nAlways-on project conventions.\n',
      'utf8',
    )
    writeFileSync(
      join(workspaceRoot, '.cursor', 'rules', 'typescript.mdc'),
      '---\nglobs: ["**/*.ts"]\nalwaysApply: false\n---\nTypeScript-only conventions.\n',
      'utf8',
    )
    writeFileSync(
      join(workspaceRoot, '.cursor', 'rules', 'rpc.mdc'),
      '---\ndescription: RPC service conventions for the backend\nalwaysApply: false\n---\nRPC body.\n',
      'utf8',
    )
    writeFileSync(
      join(workspaceRoot, '.cursor', 'rules', 'migration.mdc'),
      '---\nalwaysApply: false\n---\nManual migration rules.\n',
      'utf8',
    )

    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists Always / Auto / Agent / Manual Cursor rules in Settings → Sources', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const sources = dialog.$('.settings-section[data-section="customise"]')
    await expect(sources).toBeDisplayed()
    await expect(sources.$('legend=Instruction files')).toBeDisplayed()

    const instructionsList = sources.$('#sources-instructions-list')
    await browser.waitUntil(async () => (await instructionsList.getText()).includes('AGENTS.md'), {
      timeout: 15_000,
      timeoutMsg: 'expected the project instructions in Sources',
    })
    const instructionRow = instructionsList.$('.sources-row*=AGENTS.md')
    const trustBadge = instructionRow.$('.sources-badge-untrusted')
    // getText() reports the badge's rendered (CSS-uppercased) label.
    await expect(trustBadge).toHaveText('not loaded', { ignoreCase: true })
    await expect(instructionRow.$('.sources-row-detail')).toHaveText(
      expect.stringContaining('inert until you trust this workspace'),
    )

    await browser.execute(() => {
      document
        .querySelector('#sources-instructions-list')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(100)
    await saveElementScreenshot(
      'fieldset:has(#sources-instructions-list)',
      'settings-sources-untrusted-instructions.png',
    )

    const rulesList = sources.$('#sources-cursor-rules-list')
    await browser.waitUntil(
      async () => {
        const text = await rulesList.getText()
        return (
          text.includes('always.mdc') &&
          text.includes('typescript.mdc') &&
          text.includes('rpc.mdc') &&
          text.includes('migration.mdc')
        )
      },
      { timeout: 15_000, timeoutMsg: 'expected all four Cursor rule kinds in Sources' },
    )
    // The block is hidden until the workspace has rules, so it can only be
    // asserted visible once the list above has arrived.
    await expect(sources.$('legend=Cursor rules')).toBeDisplayed()

    const text = await rulesList.getText()
    assert.match(text, /always/i)
    assert.match(text, /auto/i)
    assert.match(text, /agent/i)
    assert.match(text, /manual/i)
    assert.match(text, /\*\*\/\*\.ts|globs:/)

    await browser.execute(() => {
      const list = document.querySelector('#sources-cursor-rules-list')
      for (const row of list?.querySelectorAll<HTMLElement>('.sources-row') ?? []) {
        const title = row.querySelector<HTMLElement>('.sources-row-title')?.textContent
        const detail = row.querySelector<HTMLElement>('.sources-row-detail')
        if (!title || !detail?.textContent) continue
        const parts = detail.textContent.split(' · ')
        parts[parts.length - 1] = `<workspace>/${title}`
        detail.textContent = parts.join(' · ')
      }
      list?.closest('fieldset')?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(100)

    await saveElementScreenshot(
      'fieldset:has(#sources-cursor-rules-list)',
      'settings-sources-cursor-rules.png',
    )
  })
})
