import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Monaco owns the workers MonacoEnvironment.getWorker returns: it terminates
// the editor worker once the window has been idle (or model-less) long enough
// and calls getWorker again on the next diff request. The worker environment
// used to memoise the instance per label forever, so that second request got
// the already-terminated worker back — after which no diff ever computed again
// in that window. The docked Changes pane rendered every diff as plain
// uncoloured text while a freshly opened pop-out (own renderer, fresh worker)
// still coloured the same file (#1753).
//
// Waiting out Monaco's five-minute idle timer is not testable; disposing every
// model triggers the same WorkerManager stop synchronously, so the spec drives
// the identical worker-restart path the idle timer takes.

async function diffHasColouring(): Promise<boolean> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    if (!host) return false
    return (
      host.querySelector('.line-insert, .char-insert') != null &&
      host.querySelector('.line-delete, .char-delete') != null
    )
  })
}

describe('git changes diff colouring after a worker restart', function () {
  this.timeout(120_000)

  let repoRoot = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await browser.waitUntil(
      async () => (await (await $('.workspace-name')).getText()) !== 'No folder',
      { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
    )
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('recolours the diff after Monaco stopped and restarted its editor worker', async () => {
    const changesBtn = await $('.titlebar-btn[aria-label="Open changes"]')
    await changesBtn.waitForExist({ timeout: 30_000 })
    await changesBtn.click()
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await (await $('.git-changes-refresh-btn')).click()
    await browser.waitUntil(async () => (await $$('.git-change-row')).length >= 3, {
      timeout: 30_000,
      timeoutMsg: 'expected changed-file rows',
    })

    // Baseline: the auto-selected staged.ts diff computes and colours.
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(diffHasColouring, {
      timeout: 15_000,
      timeoutMsg: 'expected insert+delete colouring on the first diff',
    })

    // Monaco's WorkerManager stops the editor worker as soon as the model
    // count reaches zero — the same stop its five-minute idle timer performs.
    await browser.execute(() => {
      for (const model of window.__copseMonaco?.editor.getModels() ?? []) model.dispose()
    })

    // A changed file forces a real model rebuild and a fresh diff computation,
    // which makes Monaco request a worker from getWorker again.
    writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const rewritten = true\n')
    const unstagedRow = await $('.git-change-row*=unstaged.ts')
    await unstagedRow.waitForClickable({ timeout: 30_000 })
    await unstagedRow.click()

    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(diffHasColouring, {
      timeout: 15_000,
      timeoutMsg: 'expected diff colouring after the editor worker restart (#1753)',
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-worker-restart.png'))
  })
})
