import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-monaco-selection-project'
const SAMPLE_FILE = 'selection-sample.txt'
const SCREENSHOT = 'monaco-selection-chat-attachment.png'

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

async function pressControlChord(key: string): Promise<void> {
  await browser.execute((pressedKey) => {
    const target =
      document.querySelector('#file-viewer .monaco-editor textarea') ?? document.activeElement
    if (!target) throw new Error('No target for Monaco shortcut')
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: pressedKey,
          code: `Key${pressedKey.toUpperCase()}`,
        }),
      )
    }
  }, key)
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
    const input = document.querySelector(
      '#file-viewer .monaco-editor textarea',
    ) as HTMLTextAreaElement | null
    if (!input) throw new Error('Monaco input textarea not found')
    input.focus()
  })
}

describe('Monaco selection to chat attachment', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-monaco-selection-'))
    writeFileSync(
      join(workspaceRoot, SAMPLE_FILE),
      ['Selected greeting from Monaco', 'Line two of the selected chat context', ''].join('\n'),
      'utf8',
    )
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

  it('adds the selected Monaco text to the current chat with Cmd/Ctrl+L', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const sampleRow = await $(`.tree-row[title="${SAMPLE_FILE}"]`)
    await sampleRow.waitForDisplayed({ timeout: 15_000 })
    await sampleRow.click()

    const editor = await $('#file-viewer .monaco-editor')
    await editor.waitForDisplayed({ timeout: 15_000 })
    await $('#file-viewer .monaco-editor .view-line').click()
    await focusMonacoInput()

    await pressControlChord('a')
    await pressControlChord('l')

    const chip = await $('.attachment-chip.text-chip')
    await chip.waitForDisplayed({ timeout: 5_000 })
    await expect(await chip.getText()).toContain(`${SAMPLE_FILE}:`)

    await saveAppScreenshot(SCREENSHOT)
  })
})
