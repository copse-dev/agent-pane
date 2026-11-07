import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { parkPointer, saveAppViewportScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-monaco-selection-project'
const SAMPLE_FILE = 'selection-sample.txt'
const SCREENSHOT = 'monaco-selection-chat-attachment.png'
const CONTROL_KEY = Key.Ctrl

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name').getElement()
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

async function pressControlChord(key: string): Promise<void> {
  await browser.action('key').down(CONTROL_KEY).down(key).up(key).up(CONTROL_KEY).perform()
}

async function focusMonacoInput(): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () => document.querySelector('#file-viewer .monaco-editor textarea') !== null,
      ),
    { timeout: 5_000, timeoutMsg: 'expected Monaco textarea to exist' },
  )
  await browser.execute(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      '#file-viewer .monaco-editor textarea',
    )
    if (!input) throw new Error('Monaco input textarea not found')
    input.focus()
  })
}

async function dragSelectFirstMonacoLine(): Promise<void> {
  const firstLine = await $('#file-viewer .monaco-editor .view-line').getElement()
  await firstLine.waitForDisplayed({ timeout: 5_000 })
  await firstLine.dragAndDrop({ x: 80, y: 0 }, { duration: 300 })
}

describe('Monaco selection to chat attachment', () => {
  before(async function () {
    this.timeout(120_000)
    // A fixed workspace path: the titlebar renders the folder name, and a
    // `mkdtemp` suffix there re-rendered the reference shot on every run.
    const workspaceRoot = seedStableWorkspace({
      files: {
        [SAMPLE_FILE]: [
          'Selected greeting from Monaco',
          'Line two of the selected chat context',
          '',
        ].join('\n'),
      },
    })
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
  })

  it('adds the selected Monaco text to the current chat with Cmd/Ctrl+L', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]').getElement()
    if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const sampleRow = await $(`.tree-row[title="${SAMPLE_FILE}"]`).getElement()
    await sampleRow.waitForDisplayed({ timeout: 30_000 })
    await sampleRow.click()

    const editor = await $('#file-viewer .monaco-editor').getElement()
    await editor.waitForDisplayed({ timeout: 30_000 })
    await $('#file-viewer .monaco-editor .view-line').click()
    await focusMonacoInput()

    await dragSelectFirstMonacoLine()
    await pressControlChord('l')

    // The selection lands as a chip inline in the composer text, not in the
    // detached attachment row (composer-editor.ts).
    const chip = await $('.prompt-input .inline-paste-chip').getElement()
    await chip.waitForDisplayed({ timeout: 5_000 })
    expect(await chip.getText()).toContain(`${SAMPLE_FILE}:`)

    await browser.waitUntil(
      async () =>
        await browser.execute(() => document.activeElement?.matches('.prompt-input') ?? false),
      { timeout: 5_000, timeoutMsg: 'expected chat composer to receive focus after Cmd/Ctrl+L' },
    )

    await $('#file-viewer .selected-text').waitForDisplayed({ timeout: 5_000 })
    await saveAppViewportScreenshot(SCREENSHOT, async () => {
      // The real drag can auto-scroll by a slightly different amount. Normalize
      // the viewport through a real wheel gesture after capture framing, without
      // clicking away from the composer or changing Monaco's selection.
      let settledAtStart = 0
      await browser.waitUntil(
        async () => {
          const atStart = await browser.execute(() => {
            const content = document.querySelector('#file-viewer .monaco-editor .lines-content')
            return content !== null && getComputedStyle(content).left === '0px'
          })
          settledAtStart = atStart ? settledAtStart + 1 : 0
          if (!atStart) {
            // Monaco can cap each wheel event, so keep using the real input
            // until the rendered content reaches the clamped endpoint.
            await browser
              .action('wheel')
              .scroll({ origin: editor, deltaX: -10_000, deltaY: 0, duration: 100 })
              .perform()
          }
          return settledAtStart >= 3
        },
        {
          timeout: 5_000,
          interval: 34,
          timeoutMsg: 'Monaco horizontal content did not settle at its left endpoint',
        },
      )
      await parkPointer()
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            [...document.querySelectorAll('#file-viewer .scrollbar.horizontal')].every(
              (element) => getComputedStyle(element).opacity === '0',
            ),
          ),
        { timeout: 3_000, timeoutMsg: 'Monaco scrollbar did not fade before capture' },
      )
      await expect(chip).toHaveText(expect.stringContaining(`${SAMPLE_FILE}:`))
      await expect($('#file-viewer .selected-text')).toBeDisplayed()
      expect(
        await browser.execute(() => document.activeElement?.matches('.prompt-input') ?? false),
      ).toBe(true)
      expect(
        (await $('#file-viewer .monaco-editor .lines-content').getCSSProperty('left')).value,
      ).toBe('0px')
    })
  })
})
