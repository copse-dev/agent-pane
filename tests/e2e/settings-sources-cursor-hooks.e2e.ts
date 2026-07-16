import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  restoreUserCursorHooks,
  seedEmptyProject,
  seedUserCursorHooks,
} from './helpers/seed-config.ts'

/**
 * Visual eval for issue A4 (docs/plans/hooks-and-feature-packs.md): the
 * Settings → Sources → Hooks panel must show the cursorHooksEnabled security
 * toggle, per-entry validation warnings (unknown event, empty command), and an
 * "unsupported" badge on events Copse declares but does not fire.
 *
 * Note: `.sources-badge` is CSS-upcased (text-transform), so badge text is
 * matched case-insensitively (#879).
 */
describe('settings sources hooks', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-sources-hooks')
    seedUserCursorHooks({
      version: 1,
      hooks: {
        // Valid permission hook — wired, renders as a plain row.
        beforeShellExecution: [{ command: './audit.sh' }],
        // Declared-but-unwired event — must get the "unsupported" badge.
        stop: [{ command: './notify.sh' }],
        // Unknown event — must surface as a warning row, not vanish.
        notARealEvent: [{ command: './nope.sh' }],
        // Invalid entry (empty command) — warning row too.
        beforeMCPExecution: [{ command: '' }],
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    restoreUserCursorHooks()
    resetUserData()
  })

  it('shows the toggle, validation warnings, and unsupported badge', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    await dialog.$('button[data-section="sources"]').click()
    await dialog.$('#sources-hooks-list .sources-row').waitForExist({ timeout: 15_000 })

    // The security toggle lives in the Hooks fieldset and defaults off.
    const toggle = dialog.$('input[name="cursorHooksEnabled"]')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), false)
    const fieldsetText = await dialog.$('fieldset:has(#sources-hooks-list)').getText()
    assert.match(fieldsetText, /hot path/i)
    assert.match(fieldsetText, /workspace trust/i)

    // Collect each row's title + badges + row classes.
    const rows = await browser.execute(() => {
      return Array.from(document.querySelectorAll('#sources-hooks-list .sources-row')).map(
        (row) => ({
          title: row.querySelector('.sources-row-title')?.textContent ?? '',
          badges: Array.from(row.querySelectorAll('.sources-badge')).map(
            (b) => b.textContent ?? '',
          ),
          isWarning: row.classList.contains('sources-row-warning'),
          detail: row.querySelector('.sources-row-detail')?.textContent ?? '',
        }),
      )
    })

    // The valid permission hook renders as a plain row: user scope, no
    // unsupported badge, family-prefixed command as detail.
    const shellRow = rows.find((r) => r.title === 'beforeShellExecution')
    assert.ok(shellRow, `expected a beforeShellExecution row in ${JSON.stringify(rows)}`)
    assert.ok(shellRow.badges.some((b) => /^user$/i.test(b)))
    assert.ok(!shellRow.badges.some((b) => /unsupported/i.test(b)))
    assert.equal(shellRow.detail, 'Cursor · ./audit.sh')

    // The declared-but-unwired `stop` hook is badged unsupported.
    const stopRow = rows.find((r) => r.title === 'stop')
    assert.ok(stopRow, `expected a stop row in ${JSON.stringify(rows)}`)
    assert.ok(stopRow.badges.some((b) => /unsupported/i.test(b)))

    // Both authoring problems surface as warning rows with the source path.
    const warningRows = rows.filter((r) => r.isWarning)
    assert.equal(warningRows.length, 2, `expected 2 warning rows in ${JSON.stringify(rows)}`)
    assert.ok(warningRows.some((r) => r.title.includes('notARealEvent')))
    assert.ok(warningRows.some((r) => r.title.includes('beforeMCPExecution')))
    for (const row of warningRows) {
      assert.ok(row.badges.some((b) => /warning/i.test(b)))
      assert.match(row.detail, /\.cursor\/hooks\.json$/)
    }

    // Two shots: the fieldset top (toggle + security copy + warning rows), then
    // the last row — the unwired `stop` hook — showing its "unsupported" badge
    // (the full list is taller than the dialog scrollport, so a whole-list
    // element capture would clip behind the sticky Save/Cancel footer).
    await saveElementScreenshot('fieldset:has(#sources-hooks-list)', 'settings-sources-hooks.png')
    await browser.execute(() => {
      document
        .querySelector('#sources-hooks-list .sources-row:last-child')
        ?.scrollIntoView({ block: 'center' })
    })
    await saveElementScreenshot(
      '#sources-hooks-list .sources-row:last-child',
      'settings-sources-hooks-unsupported.png',
    )
  })
})
