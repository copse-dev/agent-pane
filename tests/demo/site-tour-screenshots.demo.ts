import { $, $$, browser, expect } from '@wdio/globals'
import { collectErrorToasts } from '../e2e/helpers/assert-no-error-toasts.ts'
import { setComposerValue } from '../e2e/helpers/composer.ts'
import { E2E_VIEWPORT, saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * The copse.dev feature tour and spotlight cards (`site/index.html`) show these
 * captures, copied into `site/screenshots/`. Each opens a `site-*` scenario from
 * `src/shared/demo-site-tour.ts`: the Crumb & Bloom project from the hero
 * walkthrough, a configured model, and threads a visitor would recognise.
 */

/** Size the page itself, not the window, to the 1280×800 reference frame. */
async function useReferenceViewport(): Promise<void> {
  await browser.setWindowSize(E2E_VIEWPORT.width, E2E_VIEWPORT.height)
  const inner = await browser.execute(() => ({ width: innerWidth, height: innerHeight }))
  await browser.setWindowSize(
    E2E_VIEWPORT.width * 2 - inner.width,
    E2E_VIEWPORT.height * 2 - inner.height,
  )
}

async function openScenario(id: string): Promise<void> {
  await browser.url(`/?scenario=${id}`)
  await $('.prompt-input').waitForExist()
  // The default thread sidebar names the active thread's project on its row.
  await expect($('.thread-browser-row.selected .thread-browser-project')).toHaveText(
    'Crumb & Bloom',
  )
  // A configured model: no "(no key)" or "(offline)" suffix.
  const model = await $('.footer-model-host .model-picker-label').getText()
  expect(model).toMatch(/^Claude Opus 5\.5\b/)
  expect(model).not.toMatch(/no key|offline/i)
}

/** Let smooth scrolling finish and drop focus rings the visitor did not ask for. */
async function settleCapture(): Promise<void> {
  await browser.execute(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await browser.pause(600)
}

async function expectCleanCapture(): Promise<void> {
  expect(await collectErrorToasts()).toEqual([])
  const titles = await $$('.chat-row .chat-title').map((row) => row.getText())
  expect(titles.filter((title) => /\b(?:test|demo|fixture|mock)\b/i.test(title))).toEqual([])
}

describe('copse.dev feature tour screenshots', () => {
  before(async () => {
    await useReferenceViewport()
  })

  it('offers Fork from here and Resend on the latest prompt', async () => {
    await openScenario('site-fork-resend')
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 2)
    // Preview the site under discussion, as a visitor would from the address bar.
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    const address = $('.browser-tab-panel.is-active .browser-url-input')
    await address.waitForDisplayed()
    await address.setValue('http://localhost:61025/index.html')
    await browser.keys('Enter')
    const preview = $('.browser-tab-panel.is-active iframe.browser-webview')
    await browser.waitUntil(
      async () => (await preview.getAttribute('data-workspace-preview')) === 'ready',
      { timeoutMsg: 'expected the Crumb & Bloom preview to load' },
    )
    await browser.switchFrame(preview)
    await expect($('#signup-form')).toBeDisplayed()
    await browser.switchFrame(null)
    await settleCapture()
    const latest = $$('.messages-list .msg-user')[1]
    await latest.moveTo()
    await expect(latest.$('.msg-fork')).toBeDisplayed()
    await expect(latest.$('.msg-resend')).toBeDisplayed()
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-fork-resend.png')
  })

  it('expands a finished explore subagent in the conversation', async () => {
    await openScenario('site-subagent')
    const card = $('.tool-card-subagent')
    await card.waitForExist()
    await card.$('summary.tool-card-header').click()
    await expect(card).toHaveText(expect.stringContaining('Reading the page structure'))
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-subagent-expanded.png')
  })

  it('shows a dropped zip as an archive chip in the composer', async () => {
    await openScenario('site-archive-attachment')
    await setComposerValue('Swap in the new logo and palette from this brand kit.')
    await browser.execute(() => {
      // A valid (empty) zip, padded to the size a real brand kit would be.
      const bytes = new Uint8Array(2_400_000)
      bytes.set([0x50, 0x4b, 0x05, 0x06], bytes.length - 22)
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'brand-kit.zip', { type: 'application/zip' }))
      ;(document.querySelector('.input-row') ?? document.body).dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      )
    })
    const chip = $('.attachment-chips .archive-chip')
    await chip.waitForDisplayed()
    await expect(chip.$('.attachment-chip-label')).toHaveText('brand-kit.zip')
    await expect(chip.$('svg[data-icon="archive"]')).toExist()
    await expect($('.attachment-chips .file-chip')).not.toExist()
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-archive-attachment.png')
  })

  it('lists cloud providers, local servers, and coding agents in Settings', async () => {
    await openScenario('site-providers')
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.waitForDisplayed()
    await dialog.$('button.settings-nav-subheading=Providers').click()
    await dialog.$('.provider-chip=Anthropic').click()
    // Chips re-render on selection, so look the active one up afresh.
    await expect(dialog.$('.provider-chip.active')).toHaveText('Anthropic')
    await settleCapture()
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-provider-settings.png')
  })

  it('opens Create pull request with a proposed description', async () => {
    await openScenario('site-create-pr')
    const chip = $('.follow-up-bubble[data-id="create-pr"]')
    await chip.waitForDisplayed()
    await chip.click()
    await $('#create-pr-dialog').waitForDisplayed()
    await expect($('#create-pr-dialog .create-pr-dialog-title-input')).toHaveValue(
      'Add seasonal flavours',
    )
    await browser.waitUntil(async () =>
      (await $('#create-pr-dialog .create-pr-dialog-body-input').getValue()).includes(
        'seasonal flavours section',
      ),
    )
    // Opening selects the proposed title; leave the caret after it instead.
    await browser.execute(() => {
      const title = document.querySelector<HTMLInputElement>('.create-pr-dialog-title-input')
      title?.setSelectionRange(title.value.length, title.value.length)
    })
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-create-pr-dialog.png')
  })

  it('sets per-tool permissions for a connected MCP server', async () => {
    await openScenario('site-mcp-permissions')
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="permissions"]').click()
    const github = $('[data-group-id="mcp:project:github"]')
    await github.waitForDisplayed()
    await expect(github.$('.tool-permission-group-status')).toHaveText('connected')
    await expect(
      github.$('[data-tool-id="mcp:project:github:merge-pull-request"]'),
    ).toHaveAttribute('data-policy', 'block')
    // Bring the whole server group into view, with a little room above it.
    await browser.execute(() => {
      const group = document.querySelector('[data-group-id="mcp:project:github"]')
      group?.scrollIntoView({ block: 'start' })
      let scroller = group?.parentElement ?? null
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
        scroller = scroller.parentElement
      }
      if (scroller) scroller.scrollTop -= 14
    })
    await settleCapture()
    await expectCleanCapture()
    await saveAppScreenshot('site-tour-mcp-permissions.png')
  })
})
