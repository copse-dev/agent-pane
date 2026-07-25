import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'

/**
 * A video dropped into the chat must NOT become model content. It is stored
 * beside the thread and shown as a film chip that says how big the recording is;
 * the agent reads it through `video_frames`. This spec pins the visible half of
 * that: the composer chip and the transcript chip it turns into once sent.
 */

const PROJECT_ID = 'e2e-video-attachment-project'
const COMPOSER_SCREENSHOT = 'video-attachment-chip.png'
const TRANSCRIPT_SCREENSHOT = 'video-attachment-transcript.png'

const VIDEO_NAME = 'Screen Recording.mov'
/** Only the extension and byte length matter to the attachment path. */
const VIDEO_BYTE_LENGTH = 2048

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
 * A real `drop` on the composer, built in the page so the DataTransfer carries a
 * genuine File. Driving the hidden file input instead would skip the drag path
 * users actually take with a screen recording.
 */
async function dropVideoOnComposer(name: string, byteLength: number): Promise<void> {
  await browser.execute(
    (fileName: string, size: number) => {
      const target = document.querySelector('.input-row') ?? document.body
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(size)], fileName, { type: 'video/quicktime' }))
      target.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      )
    },
    name,
    byteLength,
  )
}

describe('Attaching a video to the chat', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-video-attachment-'))
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

  it('shows a dropped video as a film chip with its size, not an image thumbnail', async () => {
    await setComposerValue('what goes wrong at the end of this?')
    await dropVideoOnComposer(VIDEO_NAME, VIDEO_BYTE_LENGTH)

    const chip = await $('.attachment-chips .video-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    await expect(await chip.$('.attachment-chip-label').getText()).toBe(VIDEO_NAME)
    // The size is the honest cost signal — the video costs no context, but it
    // tells the user how much recording there is to read.
    await expect(await chip.$('.attachment-chip-meta').getText()).toBe('2.0 KB')
    // A film icon, not the image chip's thumbnail: this is not going to the model.
    await expect(await chip.$('svg[data-icon="video"]').isExisting()).toBe(true)
    await expect(await $('.attachment-chips .image-chip').isExisting()).toBe(false)

    await saveAppScreenshot(COMPOSER_SCREENSHOT)
  })

  it('sends the video as a path reference and renders a transcript chip', async () => {
    await $('.submit-btn').click()

    const sentChip = await $(
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-video',
    )
    await sentChip.waitForExist({ timeout: 10_000 })
    await expect(await sentChip.$('svg[data-icon="video"]').isExisting()).toBe(true)
    await expect(await sentChip.getText()).toContain(VIDEO_NAME)

    // The user sees their own words, not the steering block the agent gets.
    const shown = await $('.messages-list .msg-user .message-text').getText()
    await expect(shown).toContain('what goes wrong at the end of this?')
    await expect(shown).not.toContain('video_frames')

    // The composer clears its chips once the message is sent.
    await expect(await $('.attachment-chips .video-chip').isExisting()).toBe(false)

    await saveAppScreenshot(TRANSCRIPT_SCREENSHOT)
  })
})
