import { $, browser, expect } from '@wdio/globals'
import {
  CHILD_COPSE_SESSION_PAGE,
  CHILD_COPSE_STOP_URL,
} from '../../src/shared/child-copse-session.ts'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Child Copse control', () => {
  it('explains the scope and host-execution authority before launch', async () => {
    await browser.url('/?scenario=approval-child-copse')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog).toHaveText(expect.stringContaining('Launch and control a child Copse?'))
    await expect(dialog).toHaveText(expect.stringContaining('approve requests inside the child'))
    await expect(dialog).toHaveText(expect.stringContaining('A separate profile does not sandbox'))
    await expect(dialog).toHaveText(expect.stringContaining('30 minutes'))
    await expect(dialog).not.toHaveText(expect.stringContaining('Always allow'))
    await expect(dialog.$('.approval-approve')).toHaveText('Launch and allow control')
    await saveElementScreenshot('#approval-dialog', 'approval-child-copse.png')
  })

  it('keeps a visible Stop control outside the child instance', async () => {
    await browser.url(
      'data:text/html;charset=utf-8,' + encodeURIComponent(CHILD_COPSE_SESSION_PAGE),
    )
    const chrome = await browser.execute(() => ({
      width: window.outerWidth - window.innerWidth,
      height: window.outerHeight - window.innerHeight,
    }))
    await browser.setWindowSize(440 + chrome.width, 328 + chrome.height)
    await expect($('#session-title')).toHaveText('Child Copse session')
    await expect($('.warning')).toHaveText(
      expect.stringContaining('The agent can approve requests'),
    )
    await expect($('.warning')).toHaveText(expect.stringContaining('file and network access'))
    const fits = await browser.execute(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    )
    expect(fits).toBe(true)
    await expect($('button')).toHaveText('Stop child session')
    await expect($('form')).toHaveAttribute('action', CHILD_COPSE_STOP_URL)
    await expect($('body')).toHaveText(expect.stringContaining('Closing this window also stops'))
    await saveElementScreenshot('body', 'child-copse-stop.png')
  })
})
