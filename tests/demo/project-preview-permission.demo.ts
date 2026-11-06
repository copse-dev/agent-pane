import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('first project preview consent', () => {
  it('shows the project and one-time choices with revocation guidance in a narrow window', async () => {
    await browser.setWindowSize(900, 800)
    await browser.url('/?scenario=approval-project-preview')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog.$('.approval-heading')).toHaveText(
      'Allow this project to bind a local port?',
    )
    await expect(dialog.$('.approval-approve')).toHaveText('Allow for this project')
    await expect(dialog.$('.approval-approve-once')).toHaveText('Allow once')
    await expect(dialog.$('.approval-approve-once')).toBeDisplayed()
    await expect(dialog.$('.approval-reject')).toHaveText('Reject')
    await expect(dialog.$('.approval-remember')).not.toBeDisplayed()
    await expect(dialog.$('.approval-body')).toHaveText('npm run dev')
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining('Project: /home/mira/harbor-board'),
    )
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining('future tasks and chats in this project'),
    )
    await expect(dialog.$('.approval-footer')).toHaveText(expect.stringContaining('localhost'))
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining('Context → Permissions → Project → Local port binding'),
    )

    const geometry = await browser.execute(() => {
      const dialog = document.querySelector('#approval-dialog')
      if (!dialog) return null
      const bounds = dialog.getBoundingClientRect()
      const actions = [...dialog.querySelectorAll<HTMLElement>('.ui-actions button')].filter(
        (button) => !button.hidden,
      )
      return {
        viewportFits:
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.bottom <= window.innerHeight,
        actionCount: actions.length,
        actionsFit: actions.every((button) => {
          const action = button.getBoundingClientRect()
          return (
            action.left >= bounds.left &&
            action.right <= bounds.right &&
            action.top >= bounds.top &&
            action.bottom <= bounds.bottom
          )
        }),
      }
    })
    assert.deepEqual(geometry, { viewportFits: true, actionCount: 3, actionsFit: true })
    await saveElementScreenshot('#approval-dialog', 'project-preview-permission-choice.png')
  })
})
