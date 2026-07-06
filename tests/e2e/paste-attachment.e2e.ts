import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-paste-attachment-project'
const SCREENSHOT = 'paste-attachment-chip.png'

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

async function pasteIntoComposer(text: string): Promise<void> {
  await browser.execute(async (t) => {
    await navigator.clipboard.writeText(t)
  }, text)
  const textarea = await $('.prompt-input')
  await textarea.click()
  await browser.action('key').down(Key.Ctrl).down('v').up('v').up(Key.Ctrl).perform()
}

async function composerValue(): Promise<string> {
  return browser.execute(() => {
    const input = document.querySelector('.prompt-input')
    return input instanceof HTMLTextAreaElement ? input.value : ''
  })
}

async function clearComposer(): Promise<void> {
  await browser.execute(() => {
    const input = document.querySelector('.prompt-input')
    if (input instanceof HTMLTextAreaElement) {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
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
    await pasteIntoComposer(SHORT_PASTE)

    await browser.waitUntil(async () => (await composerValue()).includes('The editor points:'), {
      timeout: 5_000,
      timeoutMsg: 'expected short paste to land inline in the composer',
    })
    await expect(await composerValue()).toContain('- fix the typos')
    await expect(await $('.attachment-chip.text-chip').isExisting()).toBe(false)
  })

  it('folds a large paste into a chip labelled by its first non-blank line', async () => {
    await clearComposer()
    await pasteIntoComposer(LONG_PASTE)

    const chip = await $('.attachment-chip.text-chip')
    await chip.waitForDisplayed({ timeout: 5_000 })
    await expect(await chip.getText()).toContain('Editor feedback summary')
    // The paste became an attachment, so nothing lands in the textarea.
    await expect(await composerValue()).toBe('')

    await saveAppScreenshot(SCREENSHOT)
  })
})
