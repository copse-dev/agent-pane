import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  pinTextForCapture,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
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

    // A fixed path, not mkdtemp: the Sources list prints it, and a random
    // suffix made every capture differ.
    workspaceRoot = join(tmpdir(), 'copse-e2e', 'hook-test')
    rmSync(workspaceRoot, { recursive: true, force: true })
    mkdirSync(workspaceRoot, { recursive: true })
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
    seedEmptyProject(workspaceRoot, PROJECT_ID, { developerMode: true })
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
    await dialog.$('button[data-section="customise"]').click()

    const sources = dialog.$('.settings-section[data-section="customise"]')
    await expect(sources).toBeDisplayed()
    await expect(sources.$('legend=Hooks')).toBeDisplayed()

    const hooksList = sources.$('#sources-hooks-list')
    const seededRowSelector =
      './/div[@class="sources-row"]' +
      '[.//span[@class="sources-row-title" and text()="beforeShellExecution"]]' +
      '[div[@class="sources-row-header"]/span[contains(@class,"sources-badge") and text()="project"]]' +
      '[div[@class="sources-row-detail" and text()="Cursor · cat"]]'
    await browser.waitUntil(
      async () => (await hooksList.$$(seededRowSelector).getElements()).length === 1,
      {
        timeout: 15_000,
        timeoutMsg: 'expected the seeded Cursor hook to be listed',
      },
    )

    assert.equal((await hooksList.$$(seededRowSelector).getElements()).length, 1)
    const seededRow = hooksList.$(seededRowSelector)
    await expect(seededRow.$('.sources-row-title')).toHaveText('beforeShellExecution')
    await expect(seededRow.$('.sources-badge')).toHaveText('project', { ignoreCase: true })
    await expect(seededRow.$('.sources-row-detail')).toHaveText('Cursor · cat')
    const testBtn = seededRow.$('.sources-hook-test-btn')
    await expect(testBtn).toBeDisplayed()
    // Scroll the row clear of the sticky Save/Cancel footer before clicking so
    // the button is not intercepted by `.settings-buttons`.
    await testBtn.scrollIntoView({ block: 'center' })
    await testBtn.click()

    // The result panel appears once the dry-run resolves.
    const result = seededRow.$('.hook-test')
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

    // The duration chip is the hook's real run time. Pin only that chip.
    const restoreDuration = await pinTextForCapture(
      'fieldset:has(#sources-hooks-list)',
      /^\d+ ms$/,
      '40 ms',
    )
    await saveElementScreenshot(
      'fieldset:has(#sources-hooks-list)',
      'settings-sources-hook-test.png',
    )
    await restoreDuration()
  })
})
