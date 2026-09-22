import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted grouped shell approval', () => {
  before(async () => {
    await browser.url('/?scenario=approval-grouped-shell-commands')
    await $('#approval-dialog').waitForDisplayed()
  })

  it('coalesces every command under one deduplicated explanation', async () => {
    const dialog = $('#approval-dialog')
    await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
    await expect(dialog.$$('.approval-item')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-advice')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-footer')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-body-list')).toBeElementsArrayOfSize(1)
    await expect(dialog.$$('.approval-body-list .approval-body')).toBeElementsArrayOfSize(3)
    await expect(dialog.$('.approval-approve')).toHaveText('Approve all (3)')
    await expect(dialog.$('.approval-reject')).toHaveText('Reject all (3)')

    const advice = await dialog.$('.approval-advice').getText()
    assert.equal(
      advice,
      'The project sandbox would block this command:\n' +
        "• Runs a script file from the project, so Copse can't tell what it does\n" +
        '• Reaches outside the project with a ../ path',
    )
    const commands = await dialog.$$('.approval-body').map((body) => body.getText())
    assert.deepEqual(commands, [
      'node .tmp/dep-candidates.mjs',
      'mkdir -p node_modules && ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild',
      'ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild',
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
