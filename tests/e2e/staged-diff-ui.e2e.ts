import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-staged-diff-project'

async function waitForAgentIdle(timeoutMs = 60_000): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: 'Agent did not return to idle (submit button Send)',
  })
}

async function runWriteFileDirective(path: string, content: string): Promise<void> {
  const args = JSON.stringify({ path, content })
  const textarea = await $('.prompt-input')
  await textarea.setValue(`[[mcp:write_file ${args}]]`)
  await $('.submit-btn').click()
  await waitForAgentIdle()
}

describe('staged diff approval UI', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('stages diffs in the context panel with single- and multi-file selection', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await runWriteFileDirective('src/e2e-staged-a.ts', 'export const a = 1\n')

    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await $('.diff-stage').waitForDisplayed({ timeout: 10_000 })
    await $('#file-viewer .monaco-diff-editor').waitForDisplayed({ timeout: 15_000 })

    const acceptBtn = await $('#file-viewer .diff-accept-btn')
    const rejectBtn = await $('#file-viewer .diff-reject-btn')
    await acceptBtn.waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(async () => (await acceptBtn.getText()) === 'Accept', {
      timeout: 5_000,
    })
    await expect(rejectBtn).toHaveText('Reject')
    await expect($('.diff-file-list')).not.toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'staged-diff-single.png'))

    await runWriteFileDirective('src/e2e-staged-b.ts', 'export const b = 2\n')

    await browser.waitUntil(async () => (await $$('.diff-file-btn')).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'expected two queued diff file buttons',
    })

    await expect($('.diff-stage-toolbar')).toBeDisplayed()
    await expect($('button*=Accept all')).toBeDisplayed()
    await expect($('button*=Reject all')).toBeDisplayed()

    const paths = await $$('.diff-file-btn').map((btn) => btn.getText())
    await expect(paths).toContain('src/e2e-staged-a.ts')
    await expect(paths).toContain('src/e2e-staged-b.ts')

    const buttons = await $$('.diff-file-btn')
    const second = await buttons.find(async (btn) =>
      (await btn.getText()).includes('e2e-staged-b.ts'),
    )
    if (!second) throw new Error('missing e2e-staged-b.ts diff file button')
    await second.click()
    await expect(second).toHaveElementClass('selected')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'staged-diff-multi.png'))
  })
})
