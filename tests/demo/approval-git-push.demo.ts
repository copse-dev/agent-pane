import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('friendly git push approval', () => {
  for (const leased of [false, true]) {
    it(`shows the branch and ${leased ? 'lease guard' : 'fast-forward restriction'}`, async () => {
      await browser.url(`/?scenario=${leased ? 'approval-git-push-lease' : 'approval-git-push'}`)
      const dialog = $('#approval-dialog')
      await dialog.waitForDisplayed()
      await expect(dialog.$('.approval-heading')).toHaveText('Push branch to origin?')
      await expect(dialog.$('.approval-body')).toHaveText(
        'Branch: copse/friendly-action-names-213c32\nRemote: origin\n' +
          (leased
            ? 'Push mode: Force with lease\nExpected remote commit: 0123456789abcdef0123456789abcdef01234567'
            : 'Push mode: Fast-forward only'),
      )
      await expect(dialog.$('.approval-advice')).toHaveText(
        expect.stringContaining(
          leased
            ? 'can replace remote history only if'
            : 'without replacing existing remote history',
        ),
      )
      await expect(dialog.$('.approval-footer')).toHaveText('Approval covers this push once.')
      await expect(dialog.$('.approval-approve')).toHaveText('Push branch')
      await expect(dialog.$('.approval-reject')).toBeDisplayed()
      await saveElementScreenshot(
        '#approval-dialog',
        leased ? 'approval-git-push-lease.png' : 'approval-git-push.png',
      )
    })
  }
})
