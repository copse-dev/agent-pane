import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { prepareE2eScreenshot, saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('long code approval in a short window', () => {
  it('keeps the prompt and decision controls inside the chat pane', async () => {
    await browser.setWindowSize(1100, 560)
    await browser.url('/?scenario=approval-long-code')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await prepareE2eScreenshot({ width: 1100, height: 400 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('Checking generated source line 40'),
    )

    const layout = await browser.execute(() => {
      const pane = document.querySelector('#pane-chat')
      const dialog = document.querySelector('#approval-dialog')
      const heading = dialog?.querySelector('.approval-heading')
      const items = dialog?.querySelector('.approval-items')
      const body = dialog?.querySelector('.approval-body')
      const actions = dialog?.querySelector('.approval-buttons')
      if (!pane || !dialog || !heading || !items || !body || !actions) return null
      const paneRect = pane.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      const headingRect = heading.getBoundingClientRect()
      const itemsRect = items.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return {
        paneTop: paneRect.top,
        paneBottom: paneRect.bottom,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        headingTop: headingRect.top,
        itemsTop: itemsRect.top,
        itemsBottom: itemsRect.bottom,
        itemsClientHeight: items.clientHeight,
        itemsScrollHeight: items.scrollHeight,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        actionsTop: actionsRect.top,
        actionsBottom: actionsRect.bottom,
        itemsMarginBottom: Number.parseFloat(getComputedStyle(items).marginBottom),
      }
    })
    assert.ok(layout, 'approval layout exists')
    assert.ok(layout.bodyScrollHeight > layout.bodyClientHeight, 'long code body scrolls')
    assert.ok(layout.dialogTop >= layout.paneTop, 'dialog stays below the pane top')
    assert.ok(layout.dialogBottom <= layout.paneBottom, 'dialog stays above the pane bottom')
    assert.ok(layout.headingTop >= layout.dialogTop, 'heading stays inside the dialog')
    assert.ok(layout.itemsScrollHeight > layout.itemsClientHeight, 'request details scroll')
    assert.ok(layout.itemsTop >= layout.dialogTop, 'request list starts inside the dialog')
    assert.ok(layout.itemsBottom <= layout.actionsTop, 'request list clears the actions')
    // Flex layout must keep the block-layout gap: the list margin alone, not
    // the list margin plus the action row margin.
    assert.ok(
      Math.abs(layout.actionsTop - layout.itemsBottom - layout.itemsMarginBottom) <= 1,
      `actions sit one list margin below the requests (gap ${String(layout.actionsTop - layout.itemsBottom)})`,
    )
    assert.ok(
      layout.actionsBottom <= layout.dialogBottom,
      'decision controls stay inside the dialog',
    )

    const scroll = await browser.execute(() => {
      const items = document.querySelector<HTMLElement>('#approval-dialog .approval-items')
      const body = document.querySelector<HTMLElement>('#approval-dialog .approval-body')
      const footer = document.querySelector<HTMLElement>('#approval-dialog .approval-footer')
      if (!items || !body || !footer) return null
      items.scrollTop = items.scrollHeight
      body.scrollTop = body.scrollHeight
      return {
        itemsGap: items.scrollHeight - items.clientHeight - items.scrollTop,
        bodyGap: body.scrollHeight - body.clientHeight - body.scrollTop,
        footerBottom: footer.getBoundingClientRect().bottom,
        itemsBottom: items.getBoundingClientRect().bottom,
      }
    })
    assert.ok(scroll, 'long request can be scrolled')
    assert.ok(scroll.itemsGap <= 1, 'request details reach the end')
    assert.ok(scroll.bodyGap <= 1, 'code body reaches the last line')
    assert.ok(scroll.footerBottom <= scroll.itemsBottom, 'footer becomes visible above the actions')
    await saveAppScreenshot('approval-long-code-short.png', { width: 1100, height: 400 })
  })
})
