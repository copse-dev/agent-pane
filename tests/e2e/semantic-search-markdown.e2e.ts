import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSemanticSearchExploreFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('semantic search explore markdown', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSemanticSearchExploreFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders explore summary markdown without list or code formatting bugs', async () => {
    await $('.tool-card-subagent').waitForExist({ timeout: 30_000 })

    const card = await $('.tool-card-subagent')
    await expect(card.$('summary.tool-card-header .tool-name')).toHaveText('Explore files')
    await card.$('summary.tool-card-header').click()

    const layout = await browser.execute(() => {
      const intro = document.querySelector('.msg-assistant .message-text')
      const timeline = document.querySelector('.tool-card-subagent .subagent-timeline')
      const firstSummary = timeline?.querySelector('.subagent-message-assistant.message-text')
      if (!intro || !firstSummary) return { error: 'missing message roots' }

      const inspect = (root: Element) => ({
        listsInsideParagraphs: root.querySelectorAll('p ul').length,
        brokenCode: [...root.querySelectorAll('code')].some((code) =>
          code.innerHTML.includes('<em>'),
        ),
        hasItalicIs: root.innerHTML.includes('<em>is</em>'),
        hasSearchRoutingHeading: [...root.querySelectorAll('h2')].some((h) =>
          h.textContent?.includes('Search Routing Summary'),
        ),
        hasClassificationHeading: [...root.querySelectorAll('h3')].some((h) =>
          h.textContent?.includes('Classification'),
        ),
        listCount: root.querySelectorAll('ul').length,
      })

      const introMetrics = inspect(intro)
      const summaryMetrics = inspect(firstSummary)

      const classificationHeading = [...firstSummary.querySelectorAll('h3')].find((h) =>
        h.textContent?.includes('Classification'),
      )
      const classificationList = classificationHeading?.nextElementSibling
      const architectureStyleList = [...firstSummary.querySelectorAll('ul')][0]
      const firstListItem = architectureStyleList?.querySelector('li')

      return {
        introMetrics,
        summaryMetrics,
        previewHiddenWhenOpen:
          (
            document.querySelector(
              '.tool-card-subagent[open] .subagent-summary-preview',
            ) as HTMLElement | null
          )?.offsetParent === null,
        timelineHasRawHeadingMarkdown: (firstSummary.textContent ?? '').includes('##'),
        classificationHeadingFollowedByUl: classificationList?.tagName === 'UL',
        firstListItemLeft: firstListItem?.getBoundingClientRect().left ?? 0,
        headingLeft: classificationHeading?.getBoundingClientRect().left ?? 0,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.introMetrics.hasItalicIs).toBe(true)
    expect(layout.summaryMetrics.listsInsideParagraphs).toBe(0)
    expect(layout.summaryMetrics.brokenCode).toBe(false)
    expect(layout.summaryMetrics.hasSearchRoutingHeading).toBe(true)
    expect(layout.summaryMetrics.hasClassificationHeading).toBe(true)
    expect(layout.summaryMetrics.listCount).toBeGreaterThanOrEqual(2)
    expect(layout.classificationHeadingFollowedByUl).toBe(false)
    expect(layout.previewHiddenWhenOpen).toBe(true)
    expect(layout.timelineHasRawHeadingMarkdown).toBe(false)
    expect(layout.firstListItemLeft).toBeGreaterThan(layout.headingLeft + 4)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'semantic-search-explore-expanded.png'))

    await browser.execute(() => {
      const heading = [...document.querySelectorAll('.subagent-message-assistant h3')].find((h) =>
        h.textContent?.includes('Classification'),
      )
      heading?.scrollIntoView({ block: 'center' })
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'semantic-search-classification-list.png'))
  })
})
