import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { isDisplayFace, readHeadingStyle } from './helpers/heading-style.ts'
import {
  resetUserData,
  seedPrPanelChatFixture,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * Four consistency fixes from a docs/ui-taste.md review, each in its real
 * surface: the PR viewer's prose and heading faces, the dimming of a superseded
 * model row, the weight of a selected flat tab, and the PR pane header's wrap.
 * The class and option wiring behind the model row is in model-picker.test.ts
 * and model-options.test.ts; this spec proves the computed result.
 */

const AGENT_ID = 'sonnet-agent'
const SAVED_MODEL = `acp:${AGENT_ID}#claude-sonnet-4-6`
const SUCCESSOR_MODEL = `acp:${AGENT_ID}#claude-sonnet-5-5`
const PICKER = '.footer-model-host .model-picker'
const MENU = `${PICKER} .model-picker-menu`

/** A `font-family` list as bare family names, so a computed value compares with its token. */
function families(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter((name) => name !== '')
}

async function fontFamilies(
  selector: string,
): Promise<{ family: string; prose: string; ui: string } | null> {
  return browser.execute((target) => {
    const node = document.querySelector(target)
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      family: style.fontFamily,
      prose: style.getPropertyValue('--font-prose'),
      ui: style.getPropertyValue('--font-family'),
    }
  }, selector)
}

type TabBox = { key: string; pressed: boolean; left: number; width: number; weight: string }

/** Every tab matching `selector`, re-queried: the PR pane rebuilds its tabs on each switch. */
async function tabBoxes(selector: string): Promise<TabBox[]> {
  return browser.execute(
    (target) =>
      [...document.querySelectorAll<HTMLElement>(target)].map((tab) => {
        const box = tab.getBoundingClientRect()
        return {
          key: tab.dataset['section'] ?? tab.textContent.trim(),
          pressed: tab.getAttribute('aria-pressed') === 'true',
          left: box.left,
          width: box.width,
          weight: getComputedStyle(tab).fontWeight,
        }
      }),
    selector,
  )
}

/** Selecting a tab moves no tab and gives the selected one no different weight. */
async function expectSelectionKeepsTabsInPlace(
  selector: string,
  select: () => Promise<void>,
  selectedKey: string,
): Promise<void> {
  const before = await tabBoxes(selector)
  expect(before.length).toBeGreaterThan(1)
  await select()
  await browser.waitUntil(
    async () => (await tabBoxes(selector)).some((tab) => tab.key === selectedKey && tab.pressed),
    { timeout: 10_000, timeoutMsg: `expected the ${selectedKey} tab to be selected` },
  )
  const after = await tabBoxes(selector)
  expect(after.filter((tab) => tab.pressed).map((tab) => tab.key)).toEqual([selectedKey])
  expect(after.map(({ key, left, width }) => ({ key, left, width }))).toEqual(
    before.map(({ key, left, width }) => ({ key, left, width })),
  )
  expect(new Set(after.map((tab) => tab.weight)).size).toBe(1)
}

const PR_HEADER = '#pr-list-host .pane-header'

/** The PR list header's box, wrap and row alignment, rounded to whole pixels. */
async function prHeaderLayout(): Promise<{
  width: number
  height: number
  wrap: string
  overflows: boolean
  titleTruncated: boolean
  titleCentre: number
  controlCentres: number[]
}> {
  const layout = await browser.execute((target) => {
    const node = document.querySelector<HTMLElement>(target)
    const title = node?.querySelector<HTMLElement>(':scope > .pane-header-title')
    if (!node || !title) return null
    const centre = (child: Element): number => {
      const box = child.getBoundingClientRect()
      return Math.round(box.top + box.height / 2)
    }
    const box = node.getBoundingClientRect()
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      wrap: getComputedStyle(node).flexWrap,
      overflows: node.scrollWidth > node.clientWidth,
      titleTruncated: title.scrollWidth > title.clientWidth,
      titleCentre: centre(title),
      controlCentres: [...node.children].filter((child) => child !== title).map(centre),
    }
  }, PR_HEADER)
  if (!layout) throw new Error('Missing PR pane header')
  return layout
}

/** Drag the list column's resizer, as a user would, until the PR header is `width` wide. */
async function dragListColumnTo(width: number): Promise<void> {
  const current = await $(PR_HEADER).getSize('width')
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ origin: await $('#resizer-tree').getElement() })
    .down({ button: 0 })
    .move({ origin: 'pointer', x: width - current, y: 0, duration: 200 })
    .up({ button: 0 })
    .perform()
  await browser.waitUntil(async () => (await $(PR_HEADER).getSize('width')) === width, {
    timeout: 5_000,
    timeoutMsg: `expected the PR list column to narrow to ${String(width)}px`,
  })
}

describe('UI consistency: PR pane, model picker and flat tabs', () => {
  before(async function () {
    this.timeout(120_000)
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedPrPanelChatFixture(seedStableWorkspace())
    // One ACP agent offering two Sonnet releases, with the older one saved:
    // the picker keeps it as the selected row, disabled and naming its successor.
    writeSettings({
      windowBounds: { width: 1280, height: 800 },
      layout: { projectsPaneWidth: 260, filesPaneWidth: 480, fileTreeWidth: 200 },
      model: SAVED_MODEL,
      registeredAcpAgents: [
        {
          id: AGENT_ID,
          title: 'Sonnet agent',
          command: AGENT_ID,
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
            { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          ],
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('sets PR body and comment prose in the reading face and its headings in the interface face', async function () {
    this.timeout(60_000)
    if (!(await $('#pane-files').isDisplayed())) {
      await $('[aria-label="Toggle right panel"]').click()
    }
    await $('[aria-label="Open pull requests"]').click()
    await $('.pr-detail-section[data-section="comments"]').waitForDisplayed({ timeout: 20_000 })
    await expect($('.pr-viewer-title')).toHaveText('Add GitHub PR panel tab')
    await expect($('.pr-viewer-description h2')).toHaveText('Summary')

    const body = await fontFamilies('.pr-viewer-description')
    if (!body) throw new Error('Missing PR description')
    expect(families(body.family)).toEqual(families(body.prose))
    expect(families(body.family)).not.toEqual(families(body.ui))

    const heading = await readHeadingStyle('.pr-viewer-description h2')
    const headingFonts = await fontFamilies('.pr-viewer-description h2')
    if (!heading || !headingFonts) throw new Error('Missing PR description heading')
    expect(isDisplayFace(heading.family)).toBe(false)
    expect(families(heading.family)).toEqual(families(headingFonts.ui))
    expect(heading.weight).toBe('600')
    await saveElementScreenshot('#pane-files', 'ui-consistency-pr-prose.png')

    await $('.pr-detail-section[data-section="comments"]').click()
    await $('.pr-comment-body').waitForDisplayed({ timeout: 10_000 })
    const comment = await fontFamilies('.pr-comment-body')
    if (!comment) throw new Error('Missing PR comment body')
    expect(families(comment.family)).toEqual(families(comment.prose))
    await $('.pr-detail-section[data-section="overview"]').click()
  })

  it('keeps every flat tab in place and at one weight when another is selected', async function () {
    this.timeout(60_000)
    await expectSelectionKeepsTabsInPlace(
      '.pr-detail-section',
      () => $('.pr-detail-section[data-section="comments"]').click(),
      'comments',
    )
    await saveElementScreenshot('.pr-detail-sections', 'ui-consistency-pr-tabs.png')
    await $('.pr-detail-section[data-section="overview"]').click()

    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    const dialog = $('#process-manager-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expectSelectionKeepsTabsInPlace(
      '.process-manager-tab',
      () => dialog.$('.process-manager-tab*=Network').click(),
      'Network',
    )
    await saveElementScreenshot('.process-manager-tabs', 'ui-consistency-process-manager-tabs.png')
    await dialog.$('[aria-label="Close process manager"]').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
  })

  it('keeps a superseded saved model at full strength in the picker', async function () {
    this.timeout(60_000)
    const picker = $(PICKER)
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('Sonnet')

    const saved = picker.$(`.model-picker-option[data-value="${SAVED_MODEL}"]`)
    await expect(saved).toBeDisplayed()
    await expect(saved).toBeDisabled()
    await expect(saved).toHaveText(/\(superseded by Claude Sonnet 5\.5\)/)
    // Read once the row has settled, so a missing class fails at once rather
    // than after a matcher's full wait.
    const savedClasses = ((await saved.getAttribute('class')) ?? '').split(/\s+/)
    expect(savedClasses).toContain('is-selected')
    expect(savedClasses).toContain('is-superseded')
    // Every other disabled row is dimmed to 0.5 (model-picker.css).
    expect(Number((await saved.getCSSProperty('opacity')).value)).toBe(1)
    const successor = picker.$(`.model-picker-option[data-value="${SUCCESSOR_MODEL}"]`)
    await expect(successor).toBeEnabled()
    expect(((await successor.getAttribute('class')) ?? '').split(/\s+/)).not.toContain(
      'is-superseded',
    )

    // The weekly intellect sync rewrites these scores (see model-intellect-equating.e2e.ts).
    const restoreScores = await pinTextForCapture(MENU, /(?<=intellect ~?)\d+(\.\d+)?/g, '60.0')
    try {
      await saveElementScreenshot(MENU, 'ui-consistency-superseded-model.png')
    } finally {
      await restoreScores()
    }
    await browser.keys('Escape')
  })

  it('keeps a narrow PR pane header to one band, truncating its title', async function () {
    this.timeout(60_000)
    const band = await prHeaderLayout()
    expect(band.width).toBe(200)
    expect(band.titleTruncated).toBe(false)

    // 170px is just short of the ~174px the title and its three icons need side
    // by side: when every `.pane-header` wrapped, the refresh icon dropped onto
    // a second row here, and under nowrap alone the title wrapped instead.
    await dragListColumnTo(170)
    const narrow = await prHeaderLayout()
    expect(narrow.height).toBe(band.height)
    expect(narrow.wrap).toBe('nowrap')
    expect(narrow.overflows).toBe(false)
    expect(narrow.titleTruncated).toBe(true)
    expect(narrow.controlCentres).toHaveLength(3)
    for (const controlCentre of narrow.controlCentres) {
      expect(controlCentre).toBe(narrow.titleCentre)
    }
    // Changes keeps its opt-in second row for the owner label and bulk actions.
    const changesWrap = await browser.execute(() => {
      const node = document.querySelector('.git-changes-header')
      return node ? getComputedStyle(node).flexWrap : null
    })
    expect(changesWrap).toBe('wrap')
    await saveElementScreenshot('#pane-files', 'ui-consistency-pr-header-narrow.png')

    // The resizer stops at the list's 120px minimum.
    await dragListColumnTo(120)
    const narrowest = await prHeaderLayout()
    expect(narrowest.height).toBe(band.height)
    expect(narrowest.overflows).toBe(false)
    for (const controlCentre of narrowest.controlCentres) {
      expect(controlCentre).toBe(narrowest.titleCentre)
    }
  })
})
