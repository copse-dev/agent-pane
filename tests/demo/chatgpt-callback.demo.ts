import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { CHATGPT_CALLBACK_PAGE } from '../../src/main/services/providers/chatgpt-plan-oauth.ts'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

describe('ChatGPT browser callback', () => {
  it('identifies Copse and explains the handoff when the browser keeps the tab open', async () => {
    // Keep the fallback visible for capture; the real callback attempts window.close().
    const page = CHATGPT_CALLBACK_PAGE.replace(/<script>[\s\S]*?<\/script>/, '')
    await browser.url(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)

    assert.equal(await browser.getTitle(), 'ChatGPT authorization received · Copse')
    await expect($('.brand')).toHaveText('Copse')
    await expect($('h1')).toHaveText('Authorization received')
    await expect($('.card')).toHaveText(expect.stringContaining('Return to Copse'))
    await expect($('.hint')).toHaveText(
      'If this tab stays open, you can close it and return to Copse.',
    )
    await expect($('.brand svg')).toBeDisplayed()

    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'chatgpt-callback.png'))
  })
})
