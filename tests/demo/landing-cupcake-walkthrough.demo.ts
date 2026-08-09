import { $, $$, browser, expect } from '@wdio/globals'
import { collectErrorToasts } from '../e2e/helpers/assert-no-error-toasts.ts'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('landing cupcake walkthrough', () => {
  before(async function () {
    this.timeout(180_000)
    await browser.url('/?scenario=landing&loop=0')
    await $('.msg-user').waitForExist({ timeout: 120_000 })
  })

  it('keeps the chat stable while edits are queued in the background', async () => {
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length >= 1, {
      timeout: 60_000,
      timeoutMsg: 'expected the first cupcake file to enter the proposed changes queue',
    })

    await expect($('#pane-files')).not.toBeDisplayed()
    const visibleMonacoEditors = await browser.execute(
      () =>
        [...document.querySelectorAll<HTMLElement>('.monaco-editor')].filter((editor) => {
          const rect = editor.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length,
    )
    expect(visibleMonacoEditors).toBe(0)
    await expect($('.msg-user .message-text')).toHaveText(
      'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio. Include email signup, make it feel handcrafted, and preview it when done.',
    )
    await expect($('.footer-model-host .model-picker-label')).toHaveText('Codex')
    expect(await browser.isAlertOpen()).toBe(false)
    expect(await collectErrorToasts()).toEqual([])
    await saveAppScreenshot('landing-cupcake-writing.png')
  })

  it('replays one complete turn and reveals the finished Browser preview', async () => {
    await $('.msg-assistant a[href="http://localhost:61025/index.html"]').waitForDisplayed({
      timeout: 60_000,
    })
    await browser.waitUntil(
      () =>
        browser.execute(() => document.documentElement.dataset['demoExpandedPane'] === 'browser'),
      { timeout: 30_000, timeoutMsg: 'expected autoplay to reveal the finished Browser preview' },
    )
    await expect($$('.msg-user')).toBeElementsArrayOfSize(1)
    const publishedSite = await browser.execute(async () => {
      const root = document.documentElement.dataset['demoStaticSite'] ?? ''
      const response = await fetch(`${root}/index.html`)
      return { root, ok: response.ok, html: await response.text() }
    })
    expect(publishedSite.root).toBe('sites/cupcakes')
    expect(publishedSite.ok).toBe(true)
    expect(publishedSite.html).toContain('<title>Crumb & Bloom')
    const projectName = await browser.execute(
      () => document.querySelector('.project-name')?.textContent ?? '',
    )
    expect(projectName).toBe('Crumb & Bloom')
    await expect($('.msg-user .message-text')).toHaveText(expect.stringContaining('Crumb & Bloom'))
    await expect($('.msg-user .message-text')).not.toHaveText(
      expect.stringContaining('workspace is intentionally empty'),
    )
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
    expect(tokenLabel).toBe('1.4k tokens')
    await expect($('.titlebar-btn[aria-label="Open browser"]')).toHaveElementClass('active')
    await $('#browser-viewer-host').waitForDisplayed({ timeout: 10_000 })
    const address = $('.browser-tab-panel.is-active .browser-url-input')
    await address.waitForDisplayed({ timeout: 10_000 })
    await expect(address).toHaveValue('http://localhost:61025/index.html')
    const preview = $('.browser-tab-panel.is-active iframe.browser-webview')
    await preview.waitForExist({ timeout: 10_000 })
    await browser.waitUntil(
      async () => (await preview.getAttribute('data-workspace-preview')) === 'ready',
      { timeout: 10_000, timeoutMsg: 'expected the cupcake workspace preview to finish loading' },
    )
    await browser.switchFrame(preview)
    await $('h1').waitForDisplayed({ timeout: 10_000 })
    await expect($('h1')).toHaveText(expect.stringContaining('Little cakes.'))
    await expect($('h1')).toHaveText(expect.stringContaining('Big feelings.'))
    await expect($('.signup')).toBeDisplayed()
    await expect($('.hero-art')).toBeDisplayed()
    await $('.signup input[type="email"]').setValue('demo@example.com')
    await $('.signup button[type="submit"]').click()
    await expect($('#form-note')).toHaveText("You're on the list — we'll save you the first swirl.")
    await expect($('.signup button[type="submit"]')).toHaveText(
      expect.stringContaining('You’re in!'),
    )
    const previewLayout = await browser.execute(() => ({
      viewportWidth: window.innerWidth,
      columns: getComputedStyle(document.querySelector('.hero') ?? document.body)
        .gridTemplateColumns,
    }))
    expect(previewLayout.viewportWidth).toBeGreaterThan(980)
    expect(previewLayout.columns.split(' ')).toHaveLength(2)
    await browser.switchFrame(null)

    const expand = $('.browser-toolbar .pane-popout-btn')
    await expect($('#titlebar')).toBeDisplayed()
    await expect($('#pane-chat')).toBeDisplayed()
    await expect($('#pane-projects')).not.toBeDisplayed()
    await expect($('#right-sidebar')).not.toBeDisplayed()
    await expect(expand).toHaveAttribute('aria-label', 'Restore browser')
    await expect(expand).toBeDisplayed()
    await expect(expand).toHaveElementClass('pane-popout-btn')
    await expect($('.browser-url-input')).not.toBeFocused()
    await expect($('.msg-assistant a[href="http://localhost:61025/index.html"]')).toBeDisplayed()
    const transcriptState = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const users = document.querySelectorAll<HTMLElement>('.msg-user')
      const latestUser = [...users].at(-1)
      const messages = document.querySelectorAll<HTMLElement>('.msg-assistant')
      const finalMessage = [...messages].at(-1)
      const listRect = list?.getBoundingClientRect()
      const userRect = latestUser?.getBoundingClientRect()
      const messageRect = finalMessage?.getBoundingClientRect()
      const composerRect = document.getElementById('input-bar')?.getBoundingClientRect()
      return {
        text: finalMessage?.textContent ?? '',
        userPosition: latestUser ? getComputedStyle(latestUser).position : '',
        overlap: Math.max(
          0,
          Math.min(userRect?.bottom ?? 0, messageRect?.bottom ?? 0) -
            Math.max(userRect?.top ?? 0, messageRect?.top ?? 0),
        ),
        top: Math.round(messageRect?.top ?? -1),
        bottom: Math.round(messageRect?.bottom ?? -1),
        visibleTop: Math.round(listRect?.top ?? -1),
        visibleBottom: Math.round(
          Math.min(
            listRect?.bottom ?? Number.POSITIVE_INFINITY,
            composerRect?.top ?? Number.POSITIVE_INFINITY,
          ),
        ),
      }
    })
    expect(transcriptState.text).toContain('Built and previewed a polished')
    expect(transcriptState.userPosition).toBe('relative')
    expect(transcriptState.overlap).toBe(0)
    expect(transcriptState.top).toBeGreaterThanOrEqual(transcriptState.visibleTop)
    expect(transcriptState.bottom).toBeLessThanOrEqual(transcriptState.visibleBottom)
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
    expect(layoutSize.chatWidth).toBe(280)
    expect(layoutSize.paneWidth).toBeGreaterThan(layoutSize.chatWidth * 3)
    expect(layoutSize.viewerWidth).toBeGreaterThan(980)
    expect(layoutSize.paneHeight).toBe(layoutSize.bodyHeight)
    expect(await collectErrorToasts()).toEqual([])
    await saveAppScreenshot('landing-cupcake-browser.png')
  })

  it('keeps the three generated files available for review', async () => {
    const restore = $('.browser-toolbar .pane-popout-btn')
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
