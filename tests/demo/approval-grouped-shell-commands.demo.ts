import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted grouped shell approval', () => {
  before(async () => {
    await browser.url('/?scenario=approval-grouped-shell-commands')
    await $('#approval-dialog').waitForDisplayed()
  })

  it('shows shared approval copy once around the command list', async () => {
    const dialog = $('#approval-dialog')
    await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
    await expect(dialog.$$('.approval-item')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-advice')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-footer')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-body-list')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-body')).toBeElementsArrayOfSize(3)
    await expect(dialog.$('.approval-advice')).toHaveText(
      'This command needs access the macOS project sandbox blocks (corepack downloads package-manager binaries).',
    )
    await expect(dialog.$('.approval-footer')).toHaveText(
      'Allow running it once outside the sandbox?',
    )
    await expect(dialog.$('.approval-approve')).toHaveText('Approve all (3)')
    await expect(dialog.$('.approval-reject')).toHaveText('Reject all (3)')

    const commands = await dialog.$$('.approval-body').map((body) => body.getText())
    assert.deepEqual(commands, [
      'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm run check:oracle',
      'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm run check:e2e-syntax',
      'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm test',
    ])

    const layout = await browser.execute(() => {
      const dialog = document.querySelector('#approval-dialog')
      const list = document.querySelector('.approval-body-list')
      if (!dialog || !list) return null
      const dialogRect = dialog.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      return {
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        listTop: listRect.top,
        listBottom: listRect.bottom,
        viewportHeight: window.innerHeight,
      }
    })
    assert.ok(layout, 'grouped approval geometry must exist')
    assert.ok(layout.dialogTop >= 0)
    assert.ok(layout.dialogBottom <= layout.viewportHeight)
    assert.ok(layout.listTop > layout.dialogTop)
    assert.ok(layout.listBottom < layout.dialogBottom)

    await saveElementScreenshot('#approval-dialog', 'approval-grouped-shell-commands.png')
  })
})
