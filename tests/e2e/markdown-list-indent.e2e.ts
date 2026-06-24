import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownListFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown list indentation', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMarkdownListFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('aligns bullets consistently across multi-section messages', async () => {
    await $('.message-text h3').waitForExist({ timeout: 30_000 })

    const layout = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      if (!root) return { error: 'no message-text' }

      const listsInsideParagraphs = root.querySelectorAll('p ul').length
      const architectureHeading = [...root.querySelectorAll('h3')].find((h) =>
        h.textContent?.includes('Architecture Highlights'),
      )
      const knownFailuresSubheading = [...root.querySelectorAll('p strong')].find((s) =>
        s.textContent?.includes('Unit tests'),
      )

      const nextElementTag = (el: Element | undefined) => {
        let node = el?.nextSibling ?? null
        while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.nextSibling
        return (node as Element | null)?.tagName ?? null
      }

      const architectureList = architectureHeading?.nextElementSibling ?? null
      const knownFailuresList = knownFailuresSubheading?.closest('p')?.nextElementSibling ?? null
      const architectureItems = architectureList ? [...architectureList.querySelectorAll('li')] : []
      const architectureItem = architectureItems[0]
      const knownFailuresItem = knownFailuresList?.querySelector('li')

      const gap = (a: Element | null | undefined, b: Element | null | undefined) => {
        if (!a || !b) return 0
        return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
      }

      return {
        innerHTML: root.innerHTML.slice(0, 500),
        h3Count: root.querySelectorAll('h3').length,
        listsInsideParagraphs,
        architectureNextTag: nextElementTag(architectureHeading ?? undefined),
        knownFailuresNextTag: nextElementTag(knownFailuresSubheading?.closest('p') ?? undefined),
        architectureHeadingIsFollowedByUl: architectureList?.tagName === 'UL',
        knownFailuresHeadingIsFollowedByUl: knownFailuresList?.tagName === 'UL',
        architectureHeadingLeft: architectureHeading?.getBoundingClientRect().left ?? 0,
        architectureItemLeft: architectureItem?.getBoundingClientRect().left ?? 0,
        subheadingLeft: knownFailuresSubheading?.getBoundingClientRect().left ?? 0,
        knownFailuresItemLeft: knownFailuresItem?.getBoundingClientRect().left ?? 0,
        architectureItemGap: gap(architectureItems[0], architectureItems[1]),
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.listsInsideParagraphs).toBe(0)
    expect(layout.architectureHeadingIsFollowedByUl).toBe(true)
    expect(layout.knownFailuresHeadingIsFollowedByUl).toBe(true)
    expect(layout.architectureItemLeft).toBeGreaterThan(layout.architectureHeadingLeft + 4)
    expect(layout.knownFailuresItemLeft).toBeGreaterThan(layout.subheadingLeft + 4)
    // Bullets should be compact — not double-spaced by pre-wrap newlines or li margins.
    expect(layout.architectureItemGap).toBeLessThan(12)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-list-indent-multi-section.png'))

    await browser.execute(() => {
      const heading = [...document.querySelectorAll('.message-text h3')].find((h) =>
        h.textContent?.includes('Architecture Highlights'),
      )
      heading?.scrollIntoView({ block: 'start' })
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-list-indent-architecture.png'))
  })
})
