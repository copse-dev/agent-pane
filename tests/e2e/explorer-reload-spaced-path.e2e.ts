import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// This guards #268: on macOS with ASRT active, `fs:listDir` routes through the
// seatbelt-wrapped `sandbox-fs-worker`, whose spawn broke when the workspace
// path contained spaces. That sandbox path is darwin-only
// (`isProjectSandboxEnabled`); on other platforms `fs:listDir` is a plain
// `readdir`, so the spaced-path scenario exercises nothing it can regress and
// only adds noise to the (Linux) CI e2e shard. Scope the suite to where the
// behaviour under test actually runs.
const describeSpacedExplorer = process.platform === 'darwin' ? describe : describe.skip

describeSpacedExplorer('explorer reload with spaced workspace path', () => {
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
    // Wait for the app to finish booting the seeded workspace before touching
    // the titlebar. Until workspaceRoot is set the panel toggle no-ops (it
    // routes to add-project), so clicking too early — common on a slower
    // self-hosted runner — leaves #pane-files permanently hidden.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    rmSync(workspaceParent, { recursive: true, force: true })
  })

  it('reloads the file tree without fs:listDir errors', async () => {
    // Click the toggle until the files pane actually shows (only when it isn't
    // already open, so we never toggle it back shut) — a single click can still
    // land a beat before the workspace is ready on a constrained runner.
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    const pane = await $('#pane-files')
    await browser.waitUntil(
      async () => {
        if (await pane.isDisplayed()) return true
        await panelBtn.click()
        return false
      },
      { timeout: 30_000, interval: 1000, timeoutMsg: '#pane-files did not become visible' },
    )

    const refreshBtn = await $('.sidebar-refresh[aria-label="Refresh"]')
    await refreshBtn.waitForDisplayed({ timeout: 10_000 })
    await refreshBtn.click()

    const readmeRow = await $('.file-tree .tree-row[title="README.md"]')
    await readmeRow.waitForDisplayed({ timeout: 10_000 })
    await expect(readmeRow).toHaveText(expect.stringContaining('README.md'))

    const errorPane = await $('.file-tree .sidebar-empty')
    if (await errorPane.isExisting()) {
      const message = await errorPane.getText()
      await expect(message).not.toMatch(
        /Error invoking remote method|No such file or directory|\/bin\/bash:/i,
      )
    }

    await saveElementScreenshot('#file-tree-host', 'explorer-reload-spaced-path.png')
  })
})
