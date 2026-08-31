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

  it('keeps the browser-demo traffic lights in the settings titlebar', async () => {
    const trafficLights = await browser.execute(() => {
      const header = document.querySelector<HTMLElement>('.settings-header')
      if (!header) return null
      const headerRect = header.getBoundingClientRect()
      const lights = getComputedStyle(header, '::before')
      return {
        content: lights.content,
        background: lights.backgroundColor,
        boxShadow: lights.boxShadow,
        left: Number.parseFloat(lights.left),
        top: Number.parseFloat(lights.top),
        headerHeight: headerRect.height,
      }
    })

    assert.ok(trafficLights, 'settings header must exist')
    assert.notEqual(trafficLights.content, 'none', 'traffic lights must render in settings')
    assert.equal(trafficLights.background, 'rgb(255, 95, 87)')
    assert.match(trafficLights.boxShadow, /rgb\(254, 188, 46\)/)
    assert.match(trafficLights.boxShadow, /rgb\(40, 200, 64\)/)
    assert.equal(trafficLights.left, 18)
    assert.ok(
      Math.abs(trafficLights.top - trafficLights.headerHeight / 2) <= 1,
      'traffic lights must stay vertically centred in the settings titlebar',
    )
    await saveElementScreenshot('#settings-dialog', 'settings-demo-traffic-lights.png')
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

  // The bar covering its scrollport edge (above) is the feature; a control
  // *parked* under it is the bug. `scroll-padding-bottom` is what separates the
  // two: it takes the bar's depth out of the landing space, so a scrolled-to
  // target stops above the bar instead of under frosted glass it cannot be
  // clicked through. Keyboard focus, `scrollIntoView` and accessibility scrolls
  // all route through the same reserve.
  it('reserves the action bar depth so a scrolled-to control lands above it', async () => {
    const geometry = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const footer = document.querySelector<HTMLElement>('.settings-buttons')
      const section = document.querySelector<HTMLElement>('.settings-section.active')
      if (!content || !footer || !section) return null

      // The lowest interactive control in the section is the one most likely to
      // end up under the bar, so it is the honest subject for this assertion.
      // It has to be a control a person could actually click: a section carries
      // hidden inputs and controls folded inside a closed `<details>`, and those
      // own no point on screen — hit testing there returns the dialog behind
      // them and would fail this test for a reason that has nothing to do with
      // the bar. Scan upward for the last one that really renders.
      const candidates = [
        ...section.querySelectorAll<HTMLElement>('input, select, button, summary, textarea'),
      ]
      const target = candidates.reverse().find((control) => {
        const rect = control.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && control.checkVisibility()
      })
      if (!target) return null

      // Park it under the bar first, the way a stale scroll position or a
      // late-rendering row does, then ask the browser to scroll it into view.
      content.scrollTop = content.scrollHeight
      target.scrollIntoView({ block: 'end' })

      const targetRect = target.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const centreX = targetRect.left + targetRect.width / 2
      const centreY = targetRect.top + targetRect.height / 2
      const atCentre = document.elementFromPoint(centreX, centreY)
      return {
        reserved: Number.parseFloat(getComputedStyle(content).scrollPaddingBottom),
        footerHeight: footerRect.height,
        clearsBar: targetRect.bottom <= footerRect.top + 1,
        controlOwnsItsCentre: atCentre === target || (atCentre ? target.contains(atCentre) : false),
        centreHitTag: atCentre?.className ?? null,
        overshoot: targetRect.bottom - footerRect.top,
      }
    })

    assert.ok(geometry, 'settings content, footer, and a focusable control must exist')
    assert.ok(
      geometry.reserved >= geometry.footerHeight,
      `scroll reserve must cover the bar (reserved=${String(geometry.reserved)}px, bar=${String(geometry.footerHeight)}px)`,
    )
    assert.equal(
      geometry.clearsBar,
      true,
      `scrolled control must stop above the bar (overshoot=${String(geometry.overshoot)}px)`,
    )
    assert.equal(
      geometry.controlOwnsItsCentre,
      true,
      `the bar intercepted the scrolled control (hit .${String(geometry.centreHitTag)})`,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-footer-scroll-reserve.png')
  })
})
