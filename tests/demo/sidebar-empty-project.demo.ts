import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

async function choose(prefix: string): Promise<void> {
  const items = await $$('.context-menu-item')
  for (const item of items) {
    if ((await item.getText()).startsWith(prefix)) {
      await item.click()
      return
    }
  }
  throw new Error(`Missing menu item ${prefix}`)
}

describe('an empty unopened project in the sidebar', () => {
  for (const group of ['Status', 'None', 'Project']) {
    it(`keeps the empty project reachable in ${group} grouping`, async () => {
      await browser.url('about:blank')
      await browser.url('/?scenario=sidebar-empty-project')
      await $('.projects-filter-btn').waitForDisplayed({ timeout: 30_000 })
      await $('.projects-sort-btn').click()
      await $('.context-menu').waitForDisplayed()
      await choose(group)
      await $('.projects-filter-btn').click()
      await $('.context-menu').waitForDisplayed()
      await choose('empty-project')
      const entry = $('.project-entry[data-project-id="demo-empty-other"]')
      await expect(entry.$('.project-name')).toHaveText('empty-project')
      if (group !== 'Project') {
        await expect($('.sidebar-empty')).toHaveText('No threads yet')
        await expect(entry.$('.project-new-thread-btn')).toBeDisplayed()
      }
      for (const width of [800, 1600]) {
        await browser.setWindowSize(width, 900)
        await expect(entry).toBeDisplayed()
        await saveAppScreenshot(`sidebar-empty-project-${group.toLowerCase()}-${width}.png`)
      }
      if (group === 'Project') await entry.$('.project-row').click()
      else await entry.$('.project-new-thread-btn').click()
      await $('.chat-title').waitForDisplayed()
      await expect($('.chat-title')).toHaveText('New Thread')
      await expect($('.projects-filter-btn')).toHaveText('empty-project')
      if (group !== 'Project') await expect($('.chat-thread-owner')).toHaveText('· empty-project')
    })
  }
})
