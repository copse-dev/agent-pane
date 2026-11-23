import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

/**
 * Files picked with the paperclip from outside the project (a download, say)
 * carry an absolute path the workspace reader refuses. A text file is read from
 * the picked file instead; a binary one is refused with a toast rather than
 * vanishing or inlining its bytes into the prompt.
 */

const PROJECT_ID = 'e2e-picker-outside-project'
// A current Illustrator file is a PDF container: a text header, then binary streams.
const ILLUSTRATOR_FILE = Buffer.concat([
  Buffer.from('%PDF-1.6\n1 0 obj\n<< /Creator (Adobe Illustrator 28.0) >>\nstream\n', 'latin1'),
  Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)),
  Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
])

async function pick(path: string): Promise<void> {
  // Hand chromedriver a real file on disk, exactly as the native dialog would.
  await browser.execute(() => {
    const input = document.querySelector<HTMLInputElement>('.attach-file-input')
    if (!input) throw new Error('Missing attachment input')
    input.hidden = false
    input.style.display = 'block'
  })
  await $('.attach-file-input').setValue(path)
  // Put the input back behind the paperclip so screenshots show what a user sees.
  await browser.execute(() => {
    const input = document.querySelector<HTMLInputElement>('.attach-file-input')
    if (!input) return
    input.hidden = true
    input.style.display = ''
  })
}

describe('Attaching a file picked from outside the project', () => {
  let temporaryRoot = ''
  let downloads = ''

  before(async function () {
    this.timeout(120_000)
    temporaryRoot = mkdtempSync(join(tmpdir(), 'copse-picker-outside-'))
    const workspaceRoot = join(temporaryRoot, 'picker-project')
    downloads = join(temporaryRoot, 'Downloads')
    mkdirSync(workspaceRoot)
    mkdirSync(downloads)
    writeFileSync(join(downloads, 'print-sizes.csv'), 'size,width,height\nA3,297,420\n')
    writeFileSync(join(downloads, 'artwork.ai'), ILLUSTRATOR_FILE)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (temporaryRoot) removeE2eTree(temporaryRoot)
  })

  it('attaches a text file from outside the project as a file chip', async () => {
    await pick(join(downloads, 'print-sizes.csv'))
    await browser.waitUntil(
      async () => (await $$('.attachment-chips .attachment-chip').getElements()).length === 1,
      { timeout: 10_000, timeoutMsg: 'expected the picked text file to become a chip' },
    )
    await expect($('.attachment-chips .attachment-chip')).toHaveText(
      expect.stringContaining('print-sizes.csv'),
    )
  })

  it('refuses a binary file from outside the project with a toast instead of a chip', async () => {
    await pick(join(downloads, 'artwork.ai'))
    const toast = $('.toast-error')
    await toast.waitForDisplayed({ timeout: 10_000 })
    await expect(toast).toHaveText(
      expect.stringContaining("Can't attach artwork.ai — it isn't a text file."),
    )
    await expect(toast).toHaveText(expect.stringContaining('Attach it inside a .zip'))
    await expect(
      await $$('.attachment-chips .attachment-chip').getElements(),
    ).toBeElementsArrayOfSize(1)
    await saveAppScreenshot('picker-attachment-outside-project-binary.png')
    // The refusal is the expected outcome here; let it dismiss as a user would see it go.
    await toast.waitForExist({ reverse: true, timeout: 15_000 })
    await assertNoErrorToasts('after the binary-file refusal dismissed')
  })
})
