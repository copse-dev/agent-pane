import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// A project with no threads keeps its row and "+" when Group by drops the tree,
// so a new thread can still be started in it from the sidebar.

describe('sidebar empty project', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-empty-project')
    await $('.projects-sort-btn').waitForExist({ timeout: 30_000 })
  })

  it('shows the project row and "+" under the "No threads yet" line in Status grouping', async () => {
    await $('.project-entry .project-new-thread-btn').waitForExist({ timeout: 30_000 })
    await expect($('.sidebar-empty')).toHaveText('No threads yet')
    await expect($('.project-entry .project-name')).toHaveText('copse-demo')
    await expect($('.thread-section-heading')).not.toExist()
    await saveAppScreenshot('sidebar-empty-project-status.png')
  })
})
