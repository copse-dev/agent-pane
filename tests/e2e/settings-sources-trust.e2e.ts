// Settings → Sources: reading an untrusted workspace's AGENTS.md, then trusting
// the workspace from the badge that reports it inert.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-sources-trust'
const MARKER = 'Ship nothing without the release checklist.'
// Long enough that the row has to report KB rather than a raw byte count.
const AGENTS_MD = `# AGENTS.md\n\n${MARKER}\n\n${'Repeat the house style rules. '.repeat(240)}\n`

/**
 * The row leads with an absolute path inside a per-run temp dir. Committed
 * reference shots have to be stable, so stand in a fixed placeholder — after
 * the assertions have read the real text (same trick as the Cursor rules spec).
 */
async function maskInstructionPaths(): Promise<void> {
  await browser.execute(() => {
    const rows = document.querySelectorAll<HTMLElement>('#sources-instructions-list .sources-row')
    for (const row of rows) {
      const title = row.querySelector<HTMLElement>('.sources-row-title')?.textContent
      const detail = row.querySelector<HTMLElement>('.sources-row-detail')
      if (!title || !detail?.textContent) continue
      const parts = detail.textContent.split(' · ')
      parts[0] = `<workspace>/${title}`
      detail.textContent = parts.join(' · ')
    }
  })
}

describe('settings sources workspace trust', function () {
  // Booting the app, scanning Sources (skills, hooks, rules) and saving four
  // reference shots outruns the default budget. It has to be set on the suite:
  // @wdio/utils reads the runnable's timeout before the body runs, so raising
  // it inside the test leaves wdio's own 30s race in place (bare "Timeout").
  this.timeout(120_000)

  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-sources-trust-'))
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), AGENTS_MD, 'utf8')
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('opens an inert instruction file, then trusts the workspace from its badge', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const list = dialog.$('#sources-instructions-list')
    await browser.waitUntil(async () => (await list.getText()).includes('AGENTS.md'), {
      timeout: 15_000,
      timeoutMsg: 'expected the project instruction file in Sources',
    })

    const row = list.$('.sources-row*=AGENTS.md')
    // The badge is the control, not just a label.
    const badge = row.$('button.sources-badge-untrusted')
    await expect(badge).toBeDisplayed()
    await expect(badge).toHaveAttribute('aria-label', 'Trust this workspace to load AGENTS.md')
    const detail = await row.$('.sources-row-detail').getText()
    expect(detail).toContain('KB')
    expect(detail).not.toContain(' B ·')
    expect(detail).toContain('inert until you trust this workspace')
    await maskInstructionPaths()
    await saveElementScreenshot(
      'fieldset:has(#sources-instructions-list)',
      'settings-sources-trust-untrusted.png',
    )

    // The file name opens the contents, so the user can read what they are
    // about to trust.
    await row.$('button.sources-row-title-btn').click()
    const preview = $('dialog.attachment-preview-dialog')
    await expect(preview).toBeDisplayed()
    await expect(preview.$('.attachment-preview-title')).toHaveText('AGENTS.md')
    await browser.waitUntil(
      async () => (await preview.$('pre.attachment-preview-text').getText()).includes(MARKER),
      { timeout: 10_000, timeoutMsg: 'expected the instruction file contents in the preview' },
    )
    await saveElementScreenshot(
      'dialog.attachment-preview-dialog',
      'settings-sources-instruction-preview.png',
    )
    await preview.$('.attachment-preview-close').click()

    // Clicking the badge asks before granting trust, and says what it grants.
    await row.$('button.sources-badge-untrusted').click()
    const confirm = $('#confirm-dialog')
    await expect(confirm).toBeDisplayed()
    await expect(confirm.$('.confirm-dialog-message')).toHaveText('Trust this workspace?')
    await saveElementScreenshot('#confirm-dialog', 'settings-sources-trust-confirm.png')
    await confirm.$('.confirm-dialog-confirm').click()

    await browser.waitUntil(
      async () => (await row.$$('button.sources-badge-untrusted')).length === 0,
      { timeout: 15_000, timeoutMsg: 'expected the instruction row to reload as trusted' },
    )
    // getText() reports the badge's rendered (CSS-uppercased) label.
    await expect(row.$('.sources-badge')).toHaveText('project', { ignoreCase: true })
    expect(await row.$('.sources-row-detail').getText()).not.toContain('inert until you trust')
    await maskInstructionPaths()
    await saveElementScreenshot(
      'fieldset:has(#sources-instructions-list)',
      'settings-sources-trust-trusted.png',
    )
  })
})
