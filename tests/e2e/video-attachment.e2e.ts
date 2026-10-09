import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'

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
const REPLY = 'I’ll need the final frames or a description of the failure to diagnose the ending.'

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name').getElement()
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
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
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

    const chip = await $('.attachment-chips .video-chip').getElement()
    await chip.waitForDisplayed({ timeout: 10_000 })
    expect(await chip.$('.attachment-chip-label').getText()).toBe(VIDEO_NAME)
    // The size is the honest cost signal — the video costs no context, but it
    // tells the user how much recording there is to read.
    expect(await chip.$('.attachment-chip-meta').getText()).toBe('2.0 KB')
    // A film icon, not the image chip's thumbnail: this is not going to the model.
    expect(await chip.$('svg[data-icon="video"]').isExisting()).toBe(true)
    expect(await $('.attachment-chips .image-chip').isExisting()).toBe(false)

    await saveAppScreenshot(COMPOSER_SCREENSHOT)
  })

  it('sends the video as a path reference and renders a transcript chip', async () => {
    await installMockScenario({
      title: 'Review the screen recording',
      turns: [
        {
          user: { includes: 'what goes wrong at the end of this?' },
          responses: [{ text: REPLY }],
        },
      ],
    })
    await $('.submit-btn').click()

    const sentChip =
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-video'
    // Streaming can replace the transcript nodes between assertions. Resolve
    // each selector afresh and let the DOM matcher retry during that update.
    await expect($(sentChip)).toExist({ wait: 10_000 })
    await expect($(`${sentChip} svg[data-icon="video"]`)).toExist()
    await expect($(sentChip)).toHaveText(expect.stringContaining(VIDEO_NAME))

    // The user sees their own words, not the steering block the agent gets.
    await expect($('.messages-list .msg-user .message-text')).toHaveText(
      expect.stringContaining('what goes wrong at the end of this?'),
    )
    await expect($('.messages-list .msg-user .message-text')).not.toHaveText(
      expect.stringContaining('video_frames'),
    )

    // The composer clears its chips once the message is sent.
    await expect($('.attachment-chips .video-chip')).not.toExist()

    await expectAssistantReply(REPLY)
    await saveAppScreenshot(TRANSCRIPT_SCREENSHOT)
  })
})
