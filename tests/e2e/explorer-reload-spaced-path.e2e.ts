import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('explorer reload with spaced workspace path', () => {
  let workspaceParent: string
  let workspaceRoot: string

  before(async () => {
    resetUserData()
    workspaceParent = mkdtempSync(join(tmpdir(), 'copse-spaced-explorer-'))
    workspaceRoot = join(workspaceParent, 'e research workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'README.md'), '# Spaced path fixture\n', 'utf8')
    seedEmptyProject(workspaceRoot, 'e2e-spaced-explorer')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceParent, { recursive: true, force: true })
  })

  it('reloads the file tree without fs:listDir errors', async () => {
    await (await $('.titlebar-btn[aria-label="Toggle right panel"]')).click()
    await (await $('#pane-files')).waitForDisplayed({ timeout: 10_000 })

    const refreshBtn = await $('.sidebar-refresh[aria-label="Refresh"]')
    await refreshBtn.waitForDisplayed({ timeout: 10_000 })
    await refreshBtn.click()

    const readmeRow = await $('.file-tree .tree-row[title="README.md"]')
    await readmeRow.waitForDisplayed({ timeout: 10_000 })
    await expect(readmeRow).toHaveText(expect.stringContaining('README.md'))

    const errorPane = await $('.file-tree .sidebar-empty')
    if (await errorPane.isExisting()) {
      const message = await errorPane.getText()
      await expect(message).not.toMatch(/Error invoking remote method|No such file or directory|\/bin\/bash:/i)
    }

    await saveElementScreenshot('#file-tree-host', 'explorer-reload-spaced-path.png')
  })
})
