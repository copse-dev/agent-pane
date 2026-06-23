import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { collectErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-file-open-worker-project'
const SAMPLE_FILE = 'worker-sample.ts'

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

describe('Opening a code file does not surface worker error toasts', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-file-open-worker-'))
    writeFileSync(
      join(workspaceRoot, SAMPLE_FILE),
      [
        'export function makeServer() {',
        '  const port = 3000',
        '  return { port, listen: () => console.log(port) }',
        '}',
        '',
      ].join('\n'),
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

  it('shows the file in Monaco with its language worker and no error toast', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const sampleRow = await $(`.tree-row[title="${SAMPLE_FILE}"]`)
    await sampleRow.waitForDisplayed({ timeout: 30_000 })
    await sampleRow.click()

    const editor = await $('#file-viewer .monaco-editor')
    await editor.waitForDisplayed({ timeout: 30_000 })
    await $('#file-viewer .monaco-editor .view-line').waitForDisplayed({ timeout: 30_000 })

    // Give Monaco's TypeScript language worker time to spin up — this is the
    // path that previously rejected with an ErrorEvent and produced repeated
    // "Unexpected error: [object ErrorEvent]" toasts when a worker failed.
    await browser.pause(3_000)

    const toasts = await collectErrorToasts()
    await saveAppScreenshot('file-open-worker-no-error.png')
    await expect(toasts).toEqual([])
  })
})
