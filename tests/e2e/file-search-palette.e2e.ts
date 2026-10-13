import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Exercises the Cmd/Ctrl+P quick-open palette end to end: open it, type a query,
// see the matching file(s) from the workspace index, and choose one — which
// should reveal the explorer and load the file into the viewer.
describe('file search palette (Cmd/Ctrl+P quick open)', () => {
  let workspaceRoot: string

  before(async () => {
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-file-search-'))
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'README.md'), '# Fixture\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'src', 'zebra-widget.ts'), 'export const zebra = 1\n', 'utf8')
    seedEmptyProject(workspaceRoot, 'e2e-file-search')
    await browser.reloadSession()
    // Until workspaceRoot is set the shortcut no-ops, so wait for boot.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('opens on Cmd/Ctrl+P, lists matches while typing, and opens the chosen file', async () => {
    const dialog = await $('#file-search-dialog')

    // Fire the renderer shortcut. metaKey covers macOS, ctrlKey the rest — the
    // handler accepts either. The palette only registers after layout mounts,
    // which the .prompt-input wait above guarantees.
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, ctrlKey: true, bubbles: true }),
      )
    })
    await dialog.waitForDisplayed({ timeout: 10_000 })

    // The workspace index builds asynchronously after boot; keep typing the
    // query (each input re-runs the debounced index lookup) until the unique
    // fixture file surfaces.
    const input = await $('.file-search-input')
    await browser.waitUntil(
      async () => {
        await input.setValue('zebra-widget')
        const rows = await $$('.file-search-item')
        return rows.length > 0
      },
      { timeout: 20_000, interval: 1000, timeoutMsg: 'no file-search results for "zebra-widget"' },
    )

    const firstName = await $('.file-search-item .file-search-name')
    await expect(firstName).toHaveText(expect.stringContaining('zebra-widget.ts'))

    await saveAppScreenshot('file-search-palette.png')

    // Choosing the match closes the palette, opens the explorer, and loads the
    // file into the viewer (openWorkspaceFile → rightPanelMode: 'explorer').
    const firstItem = await $('.file-search-item')
    await firstItem.click()
    await dialog.waitForDisplayed({ timeout: 10_000, reverse: true })

    const fileTab = await $('.file-tree .tree-row[title="src/zebra-widget.ts"]')
    await fileTab.waitForDisplayed({ timeout: 10_000 })
  })
})
