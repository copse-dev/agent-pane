import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  prepareE2eScreenshot,
  parkPointer,
  savePreparedAppScreenshot,
} from './helpers/screenshot.ts'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function stagedDiffIsReady(): Promise<boolean> {
  return browser.execute(() => {
    const list = document.getElementById('git-changes-host')
    const viewer = document.getElementById('git-diff-viewer-host')
    if (!list || !viewer || list.textContent.includes('Checking committed changes')) return false
    const visible = (element: Element): boolean => {
      const bounds = element.getBoundingClientRect()
      return (
        bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden'
      )
    }
    if ([...viewer.querySelectorAll('.panel-empty')].some(visible)) return false
    const selectedPath = list.querySelector('.git-change-row.is-selected .git-change-path')
    if (selectedPath?.textContent !== 'staged.ts') return false
    const editor = viewer.querySelector('.modified-in-monaco-diff-editor[data-uri]')
    const uri = editor?.getAttribute('data-uri')
    if (!editor || !visible(editor) || !uri?.endsWith('/modified/staged.ts')) return false
    // Use the actual product-owned Monaco models, matched to this visible
    // editor. In the narrow inline view the original editor is hidden and
    // Monaco virtualizes line text, so raw textContent is not the contract.
    const models = window.__copseMonaco?.editor.getModels() ?? []
    const modified = models.find((model) => model.uri.toString() === uri)
    const originalUri = uri.replace('/modified/', '/original/')
    const original = models.find((model) => model.uri.toString() === originalUri)
    if (
      !modified?.getLinesContent().includes('export const value = 2') ||
      !original?.getLinesContent().includes('export const value = 1')
    ) {
      return false
    }
    if (
      ![...viewer.querySelectorAll('.line-insert, .char-insert')].some(visible) ||
      ![...viewer.querySelectorAll('.line-delete, .char-delete')].some(visible)
    ) {
      return false
    }
    const bars = [...viewer.querySelectorAll('.scrollbar.horizontal')]
    return bars.length > 0 && bars.every((element) => getComputedStyle(element).opacity === '0')
  })
}

async function openChanges(): Promise<void> {
  await browser.waitUntil(
    async () => (await (await $('.workspace-name').getElement()).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
  await $('.prompt-input').waitForExist({ timeout: 60_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').waitForExist({ timeout: 30_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').click()
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
  await $('.git-changes-header').waitForExist({ timeout: 30_000 })
}

// Visual eval for the "Review" gesture in the Changes view
// (docs/plans/copse-reviewer.md, P9): the button sits in the Changes header
// beside the bulk actions, only while the `copse.review` plugin is enabled —
// a level-3 contribution that follows the plugin's atomic toggle like the
// plugin-gated pane controls — and is enabled while the thread is idle.
describe('Changes view "Review" gesture', function () {
  this.timeout(120_000)

  let repoRoot = ''

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('shows Review in the Changes header once the review plugin is enabled', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture({ reviewEnabled: true })
    await browser.reloadSession()
    await openChanges()

    const button = $('.git-changes-header .git-changes-review-btn')
    await button.waitForDisplayed({ timeout: 30_000 })
    await expect(button).toHaveText('Review')
    await expect(button).toBeEnabled()
    const placement = await browser.execute(() => {
      const header = document.querySelector('.git-changes-header')
      const children = [...(header?.children ?? [])].map((node) => node.className)
      return {
        afterTitle:
          children.indexOf('git-changes-review-btn') > children.indexOf('pane-header-title'),
        beforePopout:
          children.indexOf('git-changes-review-btn') <
          children.findIndex((name) => name.includes('pane-popout')),
      }
    })
    expect(placement.afterTitle).toBe(true)
    expect(placement.beforePopout).toBe(true)

    await prepareE2eScreenshot()
    await parkPointer()
    await $('.git-change-row*=committed.ts').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(stagedDiffIsReady, {
      timeout: 30_000,
      timeoutMsg: 'Expected the selected staged.ts diff and settled viewer chrome',
    })
    expect(await stagedDiffIsReady()).toBe(true)
    await savePreparedAppScreenshot('git-changes-review-button.png')
    expect(await stagedDiffIsReady()).toBe(true)
  })

  it('hides Review while the review plugin is off', async () => {
    resetUserData()
    cleanupGitChangesFixture(repoRoot)
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await openChanges()

    // The gate resolves asynchronously through `plugins:list`; wait for the
    // header to settle before reading the button's state.
    await $(
      '#git-changes-host .git-changes-refresh-btn[aria-label="Refresh changes"]',
    ).waitForDisplayed({ timeout: 30_000 })
    await browser.pause(500)
    const hidden = await browser.execute(
      () => document.querySelector<HTMLElement>('.git-changes-review-btn')?.hidden ?? null,
    )
    expect(hidden).toBe(true)
  })
})
