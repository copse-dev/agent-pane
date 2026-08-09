import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveThreePaneScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-browser-preview-project'
let projectRoot = ''

describe('browser preview tool', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-browser-preview-'))
    writeFileSync(
      join(projectRoot, 'index.html'),
      '<!doctype html><html><head><title>Crumb & Bloom preview</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff8ed;color:#44251d;font:28px Georgia,serif}main{padding:48px;border:2px solid #d96870;border-radius:28px;background:#fff}small{display:block;margin-top:12px;font:16px system-ui}</style></head><body><main>Fresh from the Copse preview<small>Static workspace · no shell server</small></main></body></html>',
    )
    resetUserData()
    seedEmptyProject(projectRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (projectRoot) rmSync(projectRoot, { recursive: true })
  })

  it('serves the project and opens the visible Browser panel without approval', async () => {
    await setComposerValue('[[mcp:browser_preview {}]]')
    await $('.submit-btn').click()

    await expect($('.tool-card .tool-name')).toHaveText('Opened preview', { wait: 30_000 })
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    const input = await $('.browser-tab-panel.is-active .browser-url-input')
    await browser.waitUntil(async () => /^http:\/\/localhost:\d+\/$/.test(await input.getValue()), {
      timeout: 10_000,
      timeoutMsg: 'expected the visible Browser panel to show Copse\'s loopback preview URL',
    })
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
            getTitle?: () => string
          } | null
          return webview?.getTitle?.() === 'Crumb & Bloom preview'
        }),
      { timeout: 15_000, timeoutMsg: 'expected the preview page to load in the visible Browser tab' },
    )
    await expect($('.approval-dialog')).not.toExist()
    await saveThreePaneScreenshot('browser-preview-tool-visible.png')
  })
})
