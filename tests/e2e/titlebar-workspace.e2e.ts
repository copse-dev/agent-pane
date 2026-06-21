import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('titlebar workspace name', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-titlebar-'))
    seedEmptyProject(workspaceRoot, 'e2e-titlebar-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows the active project folder name after restoring on launch', async () => {
    const workspaceName = await $('.workspace-name')
    await workspaceName.waitForExist({ timeout: 15_000 })
    await expect(workspaceName).toHaveText(basename(workspaceRoot))
    await expect(workspaceName).not.toHaveText('No folder')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'titlebar-workspace-name.png'))
  })
})
