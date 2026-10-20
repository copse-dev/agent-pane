import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import {
  prepareE2eScreenshot,
  saveAppScreenshot,
  saveElementScreenshot,
} from '../e2e/helpers/screenshot.ts'

describe('approval with paragraphs and code blocks', () => {
  it('keeps all sections readable and the decisions inside a short dialog', async () => {
    await browser.setWindowSize(1100, 1200)
    await browser.url('/?scenario=approval-mixed-prose-code')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await prepareE2eScreenshot({ width: 1100, height: 1200 })

    await expect(dialog.$('.approval-heading')).toHaveText('3 requests')
    await expect(dialog.$$('.approval-item')).toBeElementsArrayOfSize(3)
    await expect(dialog.$$('.approval-body-code')).toBeElementsArrayOfSize(3)
    await expect(dialog.$('.approval-approve')).toHaveText('Approve all (3)')
    await expect(dialog.$('.approval-reject')).toHaveText('Reject all (3)')
    const advice = await browser.execute(() =>
      [...document.querySelectorAll('#approval-dialog .approval-advice')].map(
        (element) => element.textContent ?? '',
      ),
    )
    assert.equal(advice.length, 3)
    assert.ok(advice.every((paragraphs) => paragraphs.includes('\n\n')))
    await saveElementScreenshot('#approval-dialog', 'approval-mixed-prose-code.png')

    await prepareE2eScreenshot({ width: 1100, height: 400 })
    const layout = await browser.execute(() => {
      const pane = document.querySelector('#pane-chat')
      const dialog = document.querySelector('#approval-dialog')
      const items = dialog?.querySelector<HTMLElement>('.approval-items')
      const actions = dialog?.querySelector('.approval-buttons')
      if (!pane || !dialog || !items || !actions) return null
      const paneRect = pane.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      const itemsRect = items.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return {
        paneTop: paneRect.top,
        paneBottom: paneRect.bottom,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        itemsBottom: itemsRect.bottom,
        itemsClientHeight: items.clientHeight,
        itemsScrollHeight: items.scrollHeight,
        actionsTop: actionsRect.top,
        actionsBottom: actionsRect.bottom,
      }
    })
    assert.ok(layout, 'approval layout exists')
    assert.ok(layout.dialogTop >= layout.paneTop, 'dialog stays below the pane top')
    assert.ok(layout.dialogBottom <= layout.paneBottom, 'dialog stays above the pane bottom')
    assert.ok(layout.itemsScrollHeight > layout.itemsClientHeight, 'request sections scroll')
    assert.ok(layout.itemsBottom <= layout.actionsTop, 'request sections clear the actions')
    assert.ok(layout.actionsBottom <= layout.dialogBottom, 'decisions stay inside the dialog')
    await saveAppScreenshot('approval-mixed-prose-code-short.png', {
      width: 1100,
      height: 400,
    })

    const scroll = await browser.execute(() => {
      const items = document.querySelector<HTMLElement>('#approval-dialog .approval-items')
      const lastFooter = document.querySelector(
        '#approval-dialog .approval-item:last-child .approval-footer',
      )
      if (!items || !lastFooter) return null
      items.scrollTop = items.scrollHeight
      return {
        gap: items.scrollHeight - items.clientHeight - items.scrollTop,
        footerBottom: lastFooter.getBoundingClientRect().bottom,
        itemsBottom: items.getBoundingClientRect().bottom,
      }
    })
    assert.ok(scroll, 'last request can be scrolled into view')
    assert.ok(scroll.gap <= 1, 'request sections reach the end')
    assert.ok(scroll.footerBottom <= scroll.itemsBottom, 'last footer is reachable')
    await saveAppScreenshot('approval-mixed-prose-code-short-scrolled.png', {
      width: 1100,
      height: 400,
    })
  })
})
