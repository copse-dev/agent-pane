import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  parkPointer,
  prepareE2eScreenshot,
  savePreparedAppScreenshot,
} from './helpers/screenshot.ts'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

/** Option/Alt-click a titlebar panel control: the gesture that opens a pane beside the open one. */
async function altClickPanelControl(label: string): Promise<void> {
  await browser.execute((ariaLabel) => {
    document
      .querySelector(`.titlebar-btn[aria-label="${ariaLabel}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
  }, label)
}

interface SplitGeometry {
  split: boolean
  reviewBottom: number
  browserTop: number
  separatorTop: number
  diffVisible: boolean
  browserVisible: boolean
  activeControls: string[]
}

async function splitGeometry(): Promise<SplitGeometry> {
  return browser.execute(() => {
    const rect = (id: string): DOMRect | null =>
      document.getElementById(id)?.getBoundingClientRect() ?? null
    const shown = (id: string): boolean => {
      const node = document.getElementById(id)
      if (!node || node.hidden) return false
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }
    const diff = rect('git-diff-viewer-host')
    const web = rect('browser-viewer-host')
    const separator = rect('resizer-split')
    return {
      split: !!document.querySelector('#pane-files .pane-files-body.is-split'),
      reviewBottom: diff?.bottom ?? 0,
      browserTop: web?.top ?? 0,
      separatorTop: separator?.top ?? 0,
      diffVisible: shown('git-diff-viewer-host') && shown('git-changes-host'),
      browserVisible: shown('browser-viewer-host') && shown('browser-tabs-host'),
      activeControls: [...document.querySelectorAll('.titlebar-btn.active')].map(
        (btn) => btn.getAttribute('aria-label') ?? '',
      ),
    }
  })
}

// Two panes share the right panel: the thread stays on the left, its Review
// diff on top and the Browser underneath, so all three are on screen at once.
describe('split right panel', function () {
  this.timeout(120_000)

  let repoRoot = ''

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('stacks Browser under Review and closes either half from its control', async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    await $('.titlebar-btn[aria-label="Open review"]').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open review"]').click()
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('.git-change-row*=staged.ts').waitForDisplayed({ timeout: 30_000 })

    await altClickPanelControl('Open browser')
    await $('#browser-viewer-host').waitForDisplayed({ timeout: 30_000 })
    await $('#resizer-split').waitForDisplayed({ timeout: 10_000 })

    const geometry = await splitGeometry()
    expect(geometry.split).toBe(true)
    expect(geometry.diffVisible).toBe(true)
    expect(geometry.browserVisible).toBe(true)
    // Review on top, the separator between, Browser below.
    expect(geometry.separatorTop).toBeGreaterThanOrEqual(geometry.reviewBottom - 1)
    expect(geometry.browserTop).toBeGreaterThanOrEqual(geometry.separatorTop)
    expect(geometry.activeControls).toEqual(expect.arrayContaining(['Open review', 'Open browser']))
    await expect($('#pane-chat')).toBeDisplayed()

    await prepareE2eScreenshot()
    await parkPointer()
    await savePreparedAppScreenshot('right-panel-split-review-browser.png')

    // Arrow keys move the seam for keyboard users.
    const before = await splitGeometry()
    await browser.execute(() => {
      document.getElementById('resizer-split')?.focus()
    })
    await browser.keys(['ArrowDown', 'ArrowDown'])
    const after = await splitGeometry()
    expect(after.separatorTop).toBeGreaterThan(before.separatorTop)

    // Clicking Browser's own control closes only the bottom half.
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await browser.waitUntil(async () => !(await splitGeometry()).split, {
      timeout: 10_000,
      timeoutMsg: 'expected the split to close when its bottom pane is toggled off',
    })
    const single = await splitGeometry()
    expect(single.diffVisible).toBe(true)
    expect(single.browserVisible).toBe(false)
    await expect($('#resizer-split')).not.toBeDisplayed()
  })
})
