import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-roadmap-attachments'
const PENDING_SCREENSHOT = 'roadmap-attachments-pending.png'
const SAVED_SCREENSHOT = 'roadmap-attachments-saved.png'

/**
 * Roadmap items accept pasted/dropped files and images (issue #556): .jsonl
 * eval sets, screenshots for prompts. This drives the real pane in Chromium —
 * a paste of a File lands as a staged chip, Save persists it through the
 * knowledge store, and the reloaded item renders the stored chips plus the
 * list-row count badge.
 */

/** Deliver files to the form the way Chromium delivers a paste of OS files. */
async function pasteFilesIntoForm(
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await browser.execute((specs) => {
    const form = document.querySelector('.roadmap-form')
    if (!form) throw new Error('roadmap form not mounted')
    const transfer = new DataTransfer()
    for (const spec of specs) {
      const bytes = Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0))
      transfer.items.add(new File([bytes], spec.name, { type: spec.type }))
    }
    form.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, files)
}

// 1x1 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const JSONL_BASE64 = Buffer.from('{"input":"2+2","expected":"4"}\n').toString('base64')

describe('Roadmap item attachments', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-attachments-'))
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID, { roadmapPlansEnabled: true })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('stages pasted files as removable chips before saving', async () => {
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    await $('.roadmap-prompt-input').setValue('Run the eval set against the vision prompt')
    await pasteFilesIntoForm([
      { name: 'evals.jsonl', type: 'application/x-jsonlines', base64: JSONL_BASE64 },
      { name: 'prompt-shot.png', type: 'image/png', base64: PNG_BASE64 },
    ])

    await browser.waitUntil(async () => (await $$('.roadmap-attachment-chip')).length === 2, {
      timeout: 5_000,
      timeoutMsg: 'expected both pasted files to stage as chips',
    })
    // wdio's element-array .map is itself async — never wrap it in Promise.all.
    const names = await $$('.roadmap-attachment-name').map((chip) => chip.getText())
    assert.deepEqual(names, ['evals.jsonl', 'prompt-shot.png'])
    // The pending image previews from memory (no save yet).
    const thumbSrc = await $('.roadmap-attachment-thumb').getAttribute('src')
    assert.ok(thumbSrc.startsWith('data:image/png;base64,'), 'image chip shows a data-URL thumb')
    await saveAppScreenshot(PENDING_SCREENSHOT)
  })

  it('persists attachments through save and re-renders them from the store', async () => {
    await $('.roadmap-save-btn').click()

    // The saved row shows the attachment count badge...
    await browser.waitUntil(
      async () => (await $('.roadmap-attachment-indicator').isExisting()) === true,
      { timeout: 10_000, timeoutMsg: 'expected the list row to show an attachment badge' },
    )
    assert.equal(await $('.roadmap-attachment-indicator').getText(), '2')

    // ...and reopening the item renders chips hydrated from disk, image thumb included.
    await $('.roadmap-row').click()
    await browser.waitUntil(async () => (await $$('.roadmap-attachment-chip')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected stored attachments to render as chips',
    })
    await browser.waitUntil(
      async () => {
        const src = await $('.roadmap-attachment-thumb').getAttribute('src')
        return typeof src === 'string' && src.startsWith('data:image/png;base64,')
      },
      { timeout: 10_000, timeoutMsg: 'expected the stored image thumbnail to hydrate over IPC' },
    )
    await saveAppScreenshot(SAVED_SCREENSHOT)

    // Removing a stored chip stages the removal; Save persists it.
    await $('[aria-label="Remove attachment evals.jsonl"]').click()
    await $('.roadmap-save-btn').click()
    await browser.waitUntil(
      async () => {
        const badge = $('.roadmap-attachment-indicator')
        return (await badge.isExisting()) && (await badge.getText()) === '1'
      },
      { timeout: 10_000, timeoutMsg: 'expected the badge to drop to one attachment' },
    )

    // Delete through the real IPC so the note and its attachment directory
    // leave the runner's ~/.copse/knowledge rather than accumulating per run.
    await browser.execute(async () => {
      const api = (
        window as unknown as {
          api: {
            roadmap: {
              list: () => Promise<{ id: string }[]>
              delete: (id: string) => Promise<boolean>
            }
          }
        }
      ).api
      for (const item of await api.roadmap.list()) await api.roadmap.delete(item.id)
    })
    // The pane doesn't watch the store, so refresh explicitly to confirm.
    await $('.roadmap-refresh-btn').click()
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 0, {
      timeout: 10_000,
      timeoutMsg: 'expected the cleanup delete to empty the roadmap list',
    })
  })
})
