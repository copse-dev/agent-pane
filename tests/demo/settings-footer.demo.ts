import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function scrollSettingsContent(top: number): Promise<void> {
  await browser.execute((scrollTop) => {
    const content = document.querySelector<HTMLElement>('.settings-content')
    if (content) content.scrollTop = scrollTop
  }, top)
}

describe('browser-hosted settings footer geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForDisplayed()
  })

  it('keeps the scroll panel full width with a narrower centered form column', async () => {
    const geometry = await browser.execute(() => {
      const body = document.querySelector<HTMLElement>('.settings-body')
      const nav = document.querySelector<HTMLElement>('.settings-nav')
      const content = document.querySelector<HTMLElement>('.settings-content')
      const section = document.querySelector<HTMLElement>(
        '.settings-section[data-section="general"]',
      )
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      if (!body || !nav || !content || !section || !footer) return null
      const bodyRect = body.getBoundingClientRect()
      const navRect = nav.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const sectionRect = section.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      // Center within the scrollport's content box (excludes classic scrollbar).
      const contentCenterX = contentRect.left + content.clientWidth / 2
      const sectionCenterX = sectionRect.left + sectionRect.width / 2
      const footerCenterX = footerRect.left + footerRect.width / 2
      const maxContent = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--settings-content-max'),
      )
      return {
        scrollFillsBody: Math.abs(contentRect.right - bodyRect.right) <= 1,
        scrollStartsAfterNav: Math.abs(contentRect.left - navRect.right) <= 1,
        sectionWidth: sectionRect.width,
        footerWidth: footerRect.width,
        contentWidth: contentRect.width,
        maxContent,
        sectionCentered: Math.abs(sectionCenterX - contentCenterX) <= 1,
        footerCentered: Math.abs(footerCenterX - contentCenterX) <= 1,
      }
    })

    assert.ok(geometry, 'settings body / nav / content / section / footer must exist')
    assert.equal(geometry.scrollFillsBody, true, 'scroll panel must reach the body right edge')
    assert.equal(geometry.scrollStartsAfterNav, true, 'scroll panel must sit flush beside the nav')
    assert.ok(
      geometry.contentWidth > geometry.maxContent + 40,
      `scroll panel must be wider than the form column (content=${String(geometry.contentWidth)}, max=${String(geometry.maxContent)})`,
    )
    assert.ok(
      geometry.sectionWidth <= geometry.maxContent + 1,
      `form column must cap at --settings-content-max (width=${String(geometry.sectionWidth)})`,
    )
    assert.ok(
      geometry.footerWidth <= geometry.maxContent + 1,
      `footer column must cap at --settings-content-max (width=${String(geometry.footerWidth)})`,
    )
    assert.equal(geometry.sectionCentered, true, 'form column must be centered in the scroll panel')
    assert.equal(
      geometry.footerCentered,
      true,
      'footer column must be centered in the scroll panel',
    )
    await saveElementScreenshot('#settings-dialog', 'settings-content-full-width-scroll.png')
  })

  it('keeps the Save/Cancel bar flush with the bottom of the scroll area', async () => {
    await scrollSettingsContent(99_999)
    await scrollSettingsContent(400)

    const geometry = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      if (!content || !footer) return null
      const contentRect = content.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const probeX = footerRect.left + footerRect.width / 2
      const probeY = contentRect.bottom - 2
      const atBottomEdge = document.elementFromPoint(probeX, probeY)
      return {
        gap: contentRect.bottom - footerRect.bottom,
        scrollable: content.scrollHeight - content.clientHeight,
        footerOwnsBottomEdge:
          atBottomEdge === footer || (atBottomEdge ? footer.contains(atBottomEdge) : false),
        bottomEdgeTag: atBottomEdge?.tagName ?? null,
      }
    })

    assert.ok(geometry, 'settings content + footer must exist')
    assert.ok(
      geometry.scrollable > 0,
      `settings content must overflow for this test (scrollable=${String(geometry.scrollable)})`,
    )
    assert.ok(
      Math.abs(geometry.gap) <= 1,
      `sticky footer must reach scrollport bottom, gap=${String(geometry.gap)}px`,
    )
    assert.equal(
      geometry.footerOwnsBottomEdge,
      true,
      `footer must cover the scrollport bottom edge (found <${String(geometry.bottomEdgeTag)}>)`,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-footer-no-overlap.png')
  })
})
