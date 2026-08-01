import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'

/**
 * A zip dropped into the chat must NOT become model content. Before archives
 * were an attachment kind it fell through to `file.text()` and landed in the
 * prompt as binary mojibake; now it is stored beside the thread and shown as a
 * file-archive chip, and the agent unpacks it with `read_archive`. This spec
 * pins the visible half: the composer chip and the transcript chip it becomes.
 */

const PROJECT_ID = 'e2e-archive-attachment-project'
const COMPOSER_SCREENSHOT = 'archive-attachment-chip.png'
const TRANSCRIPT_SCREENSHOT = 'archive-attachment-transcript.png'

const ARCHIVE_NAME = 'bundle.zip'

/**
 * A real, minimal zip: just an end-of-central-directory record, which is a
 * valid empty archive. The attachment path only stores the bytes — nothing
 * unpacks here — but handing it a genuine archive keeps the fixture honest.
 */
const EMPTY_ZIP = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

/**
 * A real `drop` on the composer, built in the page so the DataTransfer carries
 * a genuine File — the drag path a user actually takes with a downloaded zip.
 */
async function dropArchiveOnComposer(name: string, bytes: number[]): Promise<void> {
  await browser.execute(
    (fileName: string, contents: number[]) => {
      const target = document.querySelector('.input-row') ?? document.body
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([new Uint8Array(contents)], fileName, { type: 'application/zip' }),
      )
      target.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      )
    },
    name,
    bytes,
  )
}

describe('Attaching an archive to the chat', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-archive-attachment-'))
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await waitForWorkspace()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows a dropped zip as an archive chip with its size, never as inlined text', async () => {
    await setComposerValue('what is in this bundle?')
    await dropArchiveOnComposer(ARCHIVE_NAME, EMPTY_ZIP)

    const chip = await $('.attachment-chips .archive-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    await expect(await chip.$('.attachment-chip-label').getText()).toBe(ARCHIVE_NAME)
    await expect(await chip.$('.attachment-chip-meta').getText()).toBe('22 B')
    await expect(await chip.$('svg[data-icon="archive"]').isExisting()).toBe(true)
    // The regression this whole feature fixes: a zip must never arrive as a
    // pasted-text / file chip, which is what reading it as text produced.
    await expect(await $('.attachment-chips .file-chip').isExisting()).toBe(false)

    await saveAppScreenshot(COMPOSER_SCREENSHOT)
  })

  it('sends the archive as a path reference and renders a transcript chip', async () => {
    await $('.submit-btn').click()

    const sentChip = await $(
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-archive',
    )
    await sentChip.waitForExist({ timeout: 10_000 })
    await expect(await sentChip.$('svg[data-icon="archive"]').isExisting()).toBe(true)
    await expect(await sentChip.getText()).toContain(ARCHIVE_NAME)

    // The user sees their own words, not the steering block the agent gets.
    const shown = await $('.messages-list .msg-user .message-text').getText()
    await expect(shown).toContain('what is in this bundle?')
    await expect(shown).not.toContain('read_archive')

    // The composer clears its chips once the message is sent.
    await expect(await $('.attachment-chips .archive-chip').isExisting()).toBe(false)

    await saveAppScreenshot(TRANSCRIPT_SCREENSHOT)
  })
})
