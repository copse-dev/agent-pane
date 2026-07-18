import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

// G2 (docs/plans/hooks-and-feature-packs.md): the dry-run hook tester. Each
// Sources hook row gets a "Test" button that runs the hook once against a
// synthetic payload for its event and shows stdin/stdout/stderr/exit/duration +
// the parsed outcome — without touching the live agent turn. This proves the
// renderer-visible tester (AGENTS.md: visual change ⇒ WDIO visual). The seeded
// hook is `cat`, which echoes the marshalled stdin straight back on stdout, so
// the panel shows a concrete round-trip.
const PROJECT_ID = 'e2e-settings-sources-hook-test'

describe('settings sources hooks (dry-run tester)', () => {
  let workspaceRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-hook-test-'))
    mkdirSync(join(workspaceRoot, '.cursor'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        // `cat` echoes the marshalled synthetic stdin back on stdout — a clean,
        // deterministic dry-run round-trip (exit 0, parsed ok, no opinion).
        hooks: { beforeShellExecution: [{ command: 'cat' }] },
      }),
      'utf8',
    )

    const trustedRoot = realpathSync(workspaceRoot)
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    // Project Cursor hooks are only discovered for a trusted workspace.
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

  it('dry-runs a hook and shows stdin/stdout/stderr/exit/duration in Sources', async () => {
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
      async () => (await hooksList.getText()).toLowerCase().includes('beforeshellexecution'),
      { timeout: 15_000, timeoutMsg: 'expected the seeded Cursor hook to be listed' },
    )

    const testBtn = hooksList.$('.sources-hook-test-btn')
    await expect(testBtn).toBeDisplayed()
    // Scroll the row clear of the sticky Save/Cancel footer before clicking so
    // the button is not intercepted by `.settings-buttons`.
    await testBtn.scrollIntoView({ block: 'center' })
    await testBtn.click()

    // The result panel appears once the dry-run resolves.
    const result = hooksList.$('.hook-test')
    await browser.waitUntil(
      async () => {
        const text = (await result.getText()).toLowerCase()
        return text.includes('exit 0') && text.includes('ms')
      },
      { timeout: 15_000, timeoutMsg: 'expected the dry-run result summary (exit + duration)' },
    )

    const resultText = await result.getText()
    assert.match(resultText, /exit 0/)
    assert.match(resultText, /parsed ok/i)
    assert.match(resultText, /stdin/i)
    assert.match(resultText, /stdout/i)
    assert.match(resultText, /stderr/i)
    // `cat` echoed the marshalled synthetic shell command back on stdout.
    assert.match(resultText, /copse hook dry-run/)

    // Scroll the Hooks fieldset into view — Sources is long — before capturing.
    await browser.execute(() => {
      const hooks = document.querySelector('#sources-hooks-list')
      hooks?.closest('fieldset')?.scrollIntoView({ block: 'start' })
    })
    await browser.pause(100)

    await saveElementScreenshot(
      'fieldset:has(#sources-hooks-list)',
      'settings-sources-hook-test.png',
    )
  })
})
