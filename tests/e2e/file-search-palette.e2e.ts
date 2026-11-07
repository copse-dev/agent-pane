import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

// Exercises the Cmd/Ctrl+P quick-open palette end to end: open it, type a query,
// see the matching file(s) from the workspace index, and choose one — which
// should reveal the explorer and load the file into the viewer.
describe('file search palette (Cmd/Ctrl+P quick open)', () => {
  let workspaceRoot: string

  before(async () => {
    resetUserData()
    workspaceRoot = join(mkdtempSync(join(tmpdir(), 'copse-file-search-')), 'workspace')
    mkdirSync(workspaceRoot)
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
    removeE2eTree(dirname(workspaceRoot))
  })

  it('opens on Cmd/Ctrl+P, lists matches while typing, and opens the chosen file', async () => {
    const dialog = await $('#file-search-dialog').getElement()

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
    const input = await $('.file-search-input').getElement()
    await browser.waitUntil(
      async () => {
        await input.setValue('zebra-widget')
        const rows = await $$('.file-search-item').getElements()
        return rows.length > 0
      },
      { timeout: 20_000, interval: 1000, timeoutMsg: 'no file-search results for "zebra-widget"' },
    )

    const firstName = await $('.file-search-item .file-search-name').getElement()
    await expect(firstName).toHaveText(expect.stringContaining('zebra-widget.ts'))

    // Keep the focused caret visible instead of capturing either blink phase.
    // Electron's pinned Chromium supports a steady caret without blurring the
    // search field or hiding its focus state.
    const steadyCaret = await browser.execute(() => {
      const field = document.querySelector<HTMLElement>('.file-search-input')
      if (!field || !CSS.supports('caret-animation', 'manual')) return false
      field.style.setProperty('caret-animation', 'manual')
      return getComputedStyle(field).getPropertyValue('caret-animation') === 'manual'
    })
    expect(steadyCaret).toBe(true)
    await expect(input).toBeFocused()
    await saveAppScreenshot('file-search-palette.png')

    // Close and reopen within the debounce window. The old query must not
    // replace the unfiltered results beneath the newly empty search field.
    await browser.execute(async () => {
      const field = document.querySelector<HTMLInputElement>('.file-search-input')
      const palette = document.querySelector<HTMLDialogElement>('#file-search-dialog')
      if (!field || !palette) throw new Error('Missing file search palette')
      field.value = 'zebra-widget'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      palette.close()
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }),
      )
      // Cross the known 100ms debounce boundary before asserting stability.
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    })
    await expect(input).toHaveValue('')
    await expect($('.file-search-item[title="README.md"]')).toBeDisplayed()
    await expect($('.file-search-item[title="src/zebra-widget.ts"]')).toBeDisplayed()
    await expect(input).toBeFocused()
    await saveAppScreenshot('file-search-palette-reopened.png')

    // Choosing the match closes the palette, opens the explorer, and loads the
    // file into the viewer (openWorkspaceFile → rightPanelMode: 'explorer').
    const firstItem = await $('.file-search-item[title="src/zebra-widget.ts"]').getElement()
    await firstItem.click()
    await dialog.waitForDisplayed({ timeout: 10_000, reverse: true })

    const fileTab = await $('.file-tree .tree-row[title="src/zebra-widget.ts"]').getElement()
    await fileTab.waitForDisplayed({ timeout: 10_000 })
  })
})
