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
 * vanishing or inlining its bytes into the prompt, and a text file over the cap
 * is refused as too large to save.
 */

const PROJECT_ID = 'e2e-picker-outside-project'
const MIB = 1024 * 1024
const CHIPS = '.attachment-chips .attachment-chip'

function binaryStreams(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 37) % 256
  return bytes
}

// A current Illustrator file is a PDF container: a text header with tens of KB
// of XMP metadata, then binary streams. Several MB, as the reported file was,
// so the binary check must win over the size cap.
const ILLUSTRATOR_FILE = Buffer.concat([
  Buffer.from('%PDF-1.5\n1 0 obj\n<< /Creator (Adobe Illustrator 28.0) >>\nendobj\n', 'latin1'),
  Buffer.from(`2 0 obj\n<< /Subtype /XML >>\nstream\n${' '.repeat(64 * 1024)}\nendstream\n`),
  binaryStreams(5 * MIB),
  Buffer.from('\nendobj\n%%EOF\n', 'latin1'),
])
// Exactly 5 MiB of text: 16-byte lines.
const OVERSIZED_LOG = 'GET /health 200\n'.repeat((5 * MIB) / 16)

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
    writeFileSync(join(downloads, 'server.log'), OVERSIZED_LOG)
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

  const chipCount = async (): Promise<number> => (await $$(CHIPS).getElements()).length

  async function attachTextFile(): Promise<void> {
    await pick(join(downloads, 'print-sizes.csv'))
    await browser.waitUntil(async () => (await chipCount()) === 1, {
      timeout: 10_000,
      timeoutMsg: 'expected the picked text file to become a chip',
    })
  }

  // Each refusal must leave an attached text file alone. The first test leaves
  // that chip in place; a refusal test run on its own attaches it first, so it
  // checks the same thing and captures the same screen.
  async function withTextChip(): Promise<void> {
    if ((await chipCount()) === 0) await attachTextFile()
  }

  it('attaches a text file from outside the project as a file chip', async () => {
    await attachTextFile()
    await expect($(CHIPS)).toHaveText(expect.stringContaining('print-sizes.csv'))
  })

  it('refuses a binary file from outside the project with a toast instead of a chip', async () => {
    await withTextChip()
    await pick(join(downloads, 'artwork.ai'))
    const toast = $('.toast-error')
    await toast.waitForDisplayed({ timeout: 10_000 })
    await expect(toast).toHaveText(
      expect.stringContaining("Can't attach artwork.ai — it isn't a text file."),
    )
    await expect(toast).toHaveText(expect.stringContaining('Attach it inside a .zip'))
    await expect(await $$(CHIPS).getElements()).toBeElementsArrayOfSize(1)
    await saveAppScreenshot('picker-attachment-outside-project-binary.png')
    // The refusal is the expected outcome here; let it dismiss as a user would see it go.
    await toast.waitForExist({ reverse: true, timeout: 15_000 })
    await assertNoErrorToasts('after the binary-file refusal dismissed')
  })

  it('refuses a text file over the cap as too large to save, not too much for a model', async () => {
    await withTextChip()
    await pick(join(downloads, 'server.log'))
    const toast = $('.toast-error')
    await toast.waitForDisplayed({ timeout: 10_000 })
    await expect(toast).toHaveText(
      expect.stringContaining(
        "Can't attach server.log — at 5.0 MB it's too large to save with the conversation.",
      ),
    )
    await expect(await $$(CHIPS).getElements()).toBeElementsArrayOfSize(1)
    await saveAppScreenshot('picker-attachment-outside-project-too-large.png')
    await toast.waitForExist({ reverse: true, timeout: 15_000 })
    await assertNoErrorToasts('after the too-large refusal dismissed')
  })
})
