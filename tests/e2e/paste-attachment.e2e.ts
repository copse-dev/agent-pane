import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue, composerText } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-paste-attachment-project'
const SCREENSHOT = 'paste-attachment-chip.png'
const TRANSCRIPT_SCREENSHOT = 'paste-attachment-transcript.png'

const SHORT_PASTE = 'The editor points:\n\n- tighten the intro\n- fix the typos'
// Starts with blank lines: the chip label must come from the first non-blank
// line, not render as an empty preview (the original bug).
const LONG_PASTE = `\n\nEditor feedback summary for the intro section\n${'lorem ipsum '.repeat(30)}`

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

/** Real clipboard write + Ctrl+V so the composer's paste handler runs trusted. */
async function pasteIntoComposer(text: string): Promise<void> {
  await browser.execute(async (t) => {
    await navigator.clipboard.writeText(t)
  }, text)
  const composer = await $('.prompt-input')
  await composer.click()
  await browser.action('key').down(Key.Ctrl).down('v').up('v').up(Key.Ctrl).perform()
}

describe('Pasting text into the composer', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-paste-attachment-'))
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

  it('keeps a short multi-line paste inline instead of folding it into a chip', async () => {
    await setComposerValue('')
    await pasteIntoComposer(SHORT_PASTE)

    await browser.waitUntil(async () => (await composerText()).includes('The editor points:'), {
      timeout: 5_000,
      timeoutMsg: 'expected short paste to land inline in the composer',
    })
    await expect(await composerText()).toContain('- fix the typos')
    await expect(await $('.inline-paste-chip').isExisting()).toBe(false)
  })

  it('folds a large paste into a chip inline at the caret, after the typed text', async () => {
    await setComposerValue('Please apply this feedback: ')
    await pasteIntoComposer(LONG_PASTE)

    // The chip lives inside the composer text flow (composer-editor.ts), not a
    // detached attachment row, and its label is the first non-blank line.
    const chip = await $('.prompt-input .inline-paste-chip')
    await chip.waitForDisplayed({ timeout: 5_000 })
    await expect(await chip.getText()).toContain('Editor feedback summary')

    // The typed text stays, with the chip appended after it in the same line.
    const layout = await browser.execute(() => {
      const composer = document.querySelector('.prompt-input')
      if (!(composer instanceof HTMLElement)) return null
      const chipEl = composer.querySelector('.inline-paste-chip')
      const prefix = chipEl?.previousSibling?.textContent ?? ''
      return { prefix, raw: composer.textContent ?? '' }
    })
    await expect(layout?.prefix).toBe('Please apply this feedback: ')
    // The paste's full body is chip-internal state, never raw composer text.
    await expect(layout?.raw).not.toContain('lorem ipsum')

    await saveAppScreenshot(SCREENSHOT)

    // Send it: the paste must render in the transcript as an inline SVG-icon
    // chip (composer block -> Message.attachments -> conversation.ts), not an
    // emoji or the raw pasted text.
    await $('.submit-btn').click()
    const sentChip = await $(
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-paste',
    )
    await sentChip.waitForExist({ timeout: 10_000 })
    await expect(await sentChip.$('svg[data-icon="paste"]').isExisting()).toBe(true)
    await expect(await sentChip.getText()).toContain('Editor feedback summary')
    // The object-replacement placeholder that marks the paste position never
    // shows as literal text.
    await expect(await $('.messages-list .msg-user .message-text').getText()).not.toContain('￼')

    await saveAppScreenshot(TRANSCRIPT_SCREENSHOT)
  })
})
