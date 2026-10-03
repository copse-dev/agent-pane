import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function load(scenario: string): Promise<void> {
  await browser.url(`/?scenario=product-announcements-${scenario}`)
  await $('#titlebar').waitForDisplayed()
}
async function assertFits(): Promise<void> {
  const layout = await browser.execute(() => {
    const dialog = document.querySelector('#product-announcement-dialog')
    const actions = document.querySelector('.product-announcement-actions')
    if (!dialog || !actions) throw new Error('Missing announcement')
    const rect = dialog.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: innerWidth,
      height: innerHeight,
      overflow: dialog.scrollWidth - dialog.clientWidth,
      actionsBottom: actionsRect.bottom,
    }
  })
  assert.ok(layout.left >= 0 && layout.right <= layout.width)
  assert.ok(layout.top >= 0 && layout.bottom <= layout.height)
  assert.ok(layout.actionsBottom <= layout.bottom)
  assert.ok(layout.overflow <= 1)
}

describe('shipped product announcement component', () => {
  it('shows an existing user queue and navigates to real Appearance settings', async () => {
    await load('existing')
    await $('#product-announcement-dialog').waitForDisplayed()
    await browser.execute(async () => {
      await document.fonts.ready
    })
    await expect($('#product-announcement-title')).toHaveText('Compact is now the default')
    await expect($('.product-announcement-progress')).toHaveText('1 of 2')
    assert.equal(await browser.execute(() => document.activeElement?.textContent), 'Got it')
    await assertFits()
    await saveElementScreenshot('#product-announcement-dialog', 'product-announcement-dark.png')
    await $('#product-announcement-dialog .ui-btn-secondary').click()
    await $('#settings-dialog').waitForDisplayed()
    await expect($('.settings-section[data-section="appearance"]')).toBeDisplayed()
    await expect($('#product-announcement-dialog')).not.toBeDisplayed()
    await browser.keys('Escape')
    await $('#product-announcement-dialog').waitForDisplayed()
    await expect($('#product-announcement-title')).toHaveText('Stay up to date')
    await expect($('#product-announcement-dialog .ui-btn-secondary')).not.toBeDisplayed()
    await browser.keys('Escape')
    await expect($('#product-announcement-dialog')).not.toExist()
    const history = await browser.execute(async () =>
      window.api.settings.get('acknowledgedProductAnnouncements'),
    )
    assert.deepEqual(history, ['demo-compact-released', 'demo-announcements-ready'])
  })

  it('silently records current notices for new users, including after onboarding', async () => {
    await load('fresh')
    await browser.waitUntil(async () =>
      browser.execute(() => document.documentElement.dataset['announcementsReady'] === 'true'),
    )
    await expect($('#onboarding-dialog')).toBeDisplayed()
    await expect($('#product-announcement-dialog')).not.toExist()
    await $('#onboarding-skip').click()
    await expect($('#onboarding-dialog')).not.toBeDisplayed()
    await expect($('#product-announcement-dialog')).not.toExist()
    await saveAppScreenshot('product-announcement-fresh.png')
    const history = await browser.execute(async () =>
      window.api.settings.get('acknowledgedProductAnnouncements'),
    )
    assert.deepEqual(history, ['demo-compact-released', 'demo-announcements-ready'])
  })

  it('skips old IDs on upgrade, and all IDs for an acknowledged profile', async () => {
    await load('update')
    await $('#product-announcement-dialog').waitForDisplayed()
    await expect($('#product-announcement-title')).toHaveText('Stay up to date')
    await $('#product-announcement-dialog .ui-btn-primary').click()
    await expect($('#product-announcement-dialog')).not.toExist()
    await load('seen')
    // The demo startup promises complete after the main renderer and fixtures mount.
    await browser.waitUntil(async () =>
      browser.execute(() => document.documentElement.dataset['announcementsReady'] === 'true'),
    )
    await expect($('#product-announcement-dialog')).not.toExist()
  })

  it('keeps real controls readable in light theme and a narrow pane', async () => {
    await load('existing')
    await $('#product-announcement-dialog').waitForDisplayed()
    await browser.execute(() => {
      document.documentElement.dataset['theme'] = 'light'
    })
    await assertFits()
    await saveElementScreenshot('#product-announcement-dialog', 'product-announcement-light.png')
    await browser.execute(() => {
      const dialog = document.querySelector('#product-announcement-dialog')
      if (!(dialog instanceof HTMLElement)) throw new Error('Missing dialog')
      dialog.style.width = '358px'
    })
    await assertFits()
    await saveElementScreenshot('#product-announcement-dialog', 'product-announcement-narrow.png')
    await $('#product-announcement-dialog .ui-btn-primary').click()
    await expect($('#product-announcement-title')).toHaveText('Stay up to date')
  })
})
