import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('conversation access approvals', () => {
  for (const fixture of [
    {
      access: 'read',
      title: 'Read your other threads?',
      action: 'Allow reading',
      explanation: 'read all your other conversations',
    },
    {
      access: 'send',
      title: 'Send prompts to your other threads?',
      action: 'Allow sending',
      explanation: 'send prompts that run',
    },
  ]) {
    it(`explains ${fixture.access} permission without raw tool arguments`, async () => {
      await browser.url(`/?scenario=approval-thread-${fixture.access}`)
      const dialog = $('#approval-dialog')
      await dialog.waitForDisplayed()
      await expect(dialog.$('.approval-heading')).toHaveText(fixture.title)
      await expect(dialog.$('.approval-advice')).toHaveText(
        expect.stringContaining(fixture.explanation),
      )
      await expect(dialog.$('.approval-footer')).toHaveText(
        expect.stringContaining('Context panel → Permissions'),
      )
      await expect(dialog.$('.approval-approve')).toHaveText(fixture.action)
      await expect(dialog.$('.approval-body')).not.toBeDisplayed()
      assert.ok((await dialog.getSize()).height < 400, 'the permission message should stay compact')
      await saveElementScreenshot('#approval-dialog', `approval-thread-${fixture.access}.png`)
    })
  }
})
