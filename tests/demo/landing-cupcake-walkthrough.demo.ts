import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('landing cupcake walkthrough', () => {
  before(async function () {
    this.timeout(180_000)
    await browser.url('/?scenario=landing&loop=0')
    await $('.msg-user').waitForExist({ timeout: 120_000 })
    await $('.msg-assistant a[href^="http://localhost:4173"]').waitForDisplayed({ timeout: 60_000 })
    await browser.waitUntil(
      () =>
        browser.execute(() => document.documentElement.dataset['demoExpandedPane'] === 'browser'),
      { timeout: 30_000, timeoutMsg: 'expected autoplay to reveal the finished Browser preview' },
    )
  })

  it('replays one complete turn and reveals the finished Browser preview', async () => {
    await expect($$('.msg-user')).toBeElementsArrayOfSize(1)
    const projectName = await browser.execute(
      () => document.querySelector('.project-name')?.textContent ?? '',
    )
    expect(projectName).toBe('Crumb & Bloom')
    await expect($('.msg-user .message-text')).toHaveText(expect.stringContaining('Crumb & Bloom'))
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 3, {
      timeout: 20_000,
      timeoutMsg: 'expected all three cupcake files in the proposed changes list',
    })
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector('.submit-btn')?.classList.contains('with-stop'),
        ),
      { timeout: 20_000, timeoutMsg: 'expected the replayed turn to finish' },
    )

    const tokenLabel = await browser.execute(
      () => document.querySelector('.footer-usage')?.textContent ?? '',
    )
    expect(tokenLabel).toBe('376 tokens')
    await expect($('.titlebar-btn[aria-label="Open browser"]')).toHaveElementClass('active')
    await $('#browser-viewer-host').waitForDisplayed({ timeout: 10_000 })
    const address = $('.browser-tab-panel.is-active .browser-url-input')
    await address.waitForDisplayed({ timeout: 10_000 })
    await expect(address).toHaveValue(expect.stringContaining('http://localhost:4173'))
    const preview = $('.browser-tab-panel.is-active iframe.browser-webview')
    await preview.waitForExist({ timeout: 10_000 })
    await browser.waitUntil(
      async () => (await preview.getAttribute('data-workspace-preview')) === 'ready',
      { timeout: 10_000, timeoutMsg: 'expected the cupcake workspace preview to finish loading' },
    )
    await browser.switchFrame(preview)
    await $('h1').waitForDisplayed({ timeout: 10_000 })
    await expect($('h1')).toHaveText(expect.stringContaining('Cupcakes,'))
    await expect($('h1')).toHaveText(expect.stringContaining('in full bloom.'))
    await expect($('.waitlist')).toBeDisplayed()
    await browser.switchFrame(null)

    const expand = $('#browser-tabs-host .pane-popout-btn')
    await expect($('#titlebar')).toBeDisplayed()
    await expect($('#pane-chat')).toBeDisplayed()
    await expect($('#pane-projects')).not.toBeDisplayed()
    await expect(expand).toHaveAttribute('aria-label', 'Restore browser')
    const layoutSize = await browser.execute(() => {
      const paneRect = document.getElementById('pane-files')?.getBoundingClientRect()
      const chatRect = document.getElementById('pane-chat')?.getBoundingClientRect()
      const viewerRect = document.getElementById('browser-viewer-host')?.getBoundingClientRect()
      const bodyRect = document.getElementById('body')?.getBoundingClientRect()
      return {
        paneWidth: Math.round(paneRect?.width ?? 0),
        paneHeight: Math.round(paneRect?.height ?? 0),
        chatWidth: Math.round(chatRect?.width ?? 0),
        viewerWidth: Math.round(viewerRect?.width ?? 0),
        bodyHeight: Math.round(bodyRect?.height ?? 0),
      }
    })
    expect(layoutSize.chatWidth).toBe(340)
    expect(layoutSize.paneWidth).toBeGreaterThan(layoutSize.chatWidth * 2)
    expect(layoutSize.viewerWidth).toBeGreaterThanOrEqual(780)
    expect(layoutSize.paneHeight).toBe(layoutSize.bodyHeight)
    await saveAppScreenshot('landing-cupcake-browser.png')
  })

  it('keeps the three generated files available for review', async () => {
    const restore = $('#browser-tabs-host .pane-popout-btn')
    await restore.click()
    await browser.waitUntil(
      () =>
        browser.execute(() => document.documentElement.dataset['demoExpandedPane'] === undefined),
      { timeout: 10_000, timeoutMsg: 'expected the demo layout to restore' },
    )
    const changes = $('.titlebar-btn[aria-label="Open changes"]')
    await changes.click()
    await expect(changes).toHaveElementClass('active')
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 20_000 })
    const paths = await $$('.git-change-row-proposed .git-change-path').map((row) => row.getText())
    expect(paths).toEqual(['index.html', 'styles.css', 'script.js'])
    await saveAppScreenshot('landing-cupcake-changes.png')
  })
})
