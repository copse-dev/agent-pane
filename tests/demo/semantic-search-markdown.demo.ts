import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted semantic-search markdown geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=semantic-search-markdown')
    await $('.tool-card-subagent').waitForExist()
  })

  it('keeps the expanded summary preview hidden and indents its lists', async () => {
    const card = await $('.tool-card-subagent')
    await card.$('summary.tool-card-header').click()

    const layout = await browser.execute(() => {
      const firstSummary = document.querySelector(
        '.tool-card-subagent .subagent-message-assistant.message-text',
      )
      const classificationHeading = [...(firstSummary?.querySelectorAll('h3') ?? [])].find(
        (heading) => heading.textContent?.includes('Classification'),
      )
      const firstListItem = firstSummary?.querySelector('ul li')
      const preview = document.querySelector<HTMLElement>(
        '.tool-card-subagent[open] .subagent-summary-preview',
      )
      return {
        previewHiddenWhenOpen: preview?.offsetParent === null,
        firstListItemLeft: firstListItem?.getBoundingClientRect().left ?? 0,
        headingLeft: classificationHeading?.getBoundingClientRect().left ?? 0,
      }
    })

    expect(layout.previewHiddenWhenOpen).toBe(true)
    expect(layout.firstListItemLeft).toBeGreaterThan(layout.headingLeft + 4)
    await saveAppScreenshot('semantic-search-explore-expanded.png')

    await browser.execute(() => {
      const heading = [...document.querySelectorAll('.subagent-message-assistant h3')].find(
        (candidate) => candidate.textContent?.includes('Classification'),
      )
      heading?.scrollIntoView({ block: 'center' })
    })
    await saveAppScreenshot('semantic-search-classification-list.png')
  })
})
