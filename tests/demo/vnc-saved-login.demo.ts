// A device with a saved login shows "Signed in as <user>" and a forget action in
// its expanded details. The Desktop rail defaults to 200px and resizes down to
// 120px, and at those widths the details used to keep a 46px icon indent and
// set the forget action beside the copy — which left "Signed in as saved-user"
// about 100px and broke it one word per line ("Signed / in as / saved- / user").
// This measures the rendered result at the default and a narrow rail width.
// `dialog-tokens.test.ts` pins the declarations it depends on.
import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function setRailWidth(width: number): Promise<void> {
  // The same property, on the same element, the rail's resize handle writes
  // (pane-resizer.ts `applyLayout`).
  await browser.execute((px) => {
    document.getElementById('body')?.style.setProperty('--tree-width', `${String(px)}px`)
  }, width)
}

async function measureSavedLogin() {
  return browser.execute(() => {
    const copy = document.querySelector<HTMLElement>(
      '.vnc-device.is-selected .vnc-saved-login-copy',
    )
    const forget = document.querySelector<HTMLElement>(
      '.vnc-device.is-selected .vnc-setup-forget-login',
    )
    const details = document.querySelector<HTMLElement>(
      '.vnc-device.is-selected .vnc-device-details',
    )
    const header = document.querySelector<HTMLElement>('.vnc-device.is-selected .vnc-device-header')
    const account = copy?.querySelector('strong')
    if (!copy || !forget || !details || !header || !account) return null
    const copyBox = copy.getBoundingClientRect()
    const forgetBox = forget.getBoundingClientRect()
    // Distinct line tops of an element's text, so a split word counts as two.
    const lines = (element: Element): number => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    }
    const panel = copy.closest('.vnc-controls-panel') ?? document
    return {
      // Rendered forget actions in this tab — the details' one and the
      // session controls' one must not both be on screen.
      visibleForgetActions: [
        ...panel.querySelectorAll<HTMLElement>('.vnc-forget-login, .vnc-setup-forget-login'),
      ].filter((button) => button.getClientRects().length > 0).length,
      accountLines: lines(account),
      forgetLines: lines(forget),
      text: copy.textContent ?? '',
      copyHeight: copyBox.height,
      copyBottom: copyBox.bottom,
      lineHeight: Number.parseFloat(getComputedStyle(copy).lineHeight),
      forgetTop: forgetBox.top,
      forgetRight: forgetBox.right,
      forgetText: forget.textContent ?? '',
      forgetClass: forget.className,
      detailsRight: details.getBoundingClientRect().right,
      detailsPaddingLeft: getComputedStyle(details).paddingLeft,
      headerPaddingLeft: getComputedStyle(header).paddingLeft,
      railWidth: document.querySelector('.right-sidebar')?.getBoundingClientRect().width ?? 0,
    }
  })
}

describe('remote desktop saved-login details', () => {
  before(async () => {
    await browser.url('/?scenario=vnc-saved-login')
    const control = $('[data-panel-control="vnc"]')
    await control.waitForDisplayed({ timeout: 20_000 })
    await control.click()
    await $('.vnc-device.is-selected .vnc-saved-login').waitForDisplayed({ timeout: 20_000 })
  })

  for (const width of [200, 160]) {
    it(`reads on one or two lines in a ${String(width)}px rail`, async () => {
      await setRailWidth(width)
      const measured = await measureSavedLogin()
      assert.ok(measured, 'the selected device must show its saved-login details')
      assert.ok(
        Math.abs(measured.railWidth - width) <= 1,
        `rail should be ${String(width)}px, got ${String(measured.railWidth)}`,
      )
      assert.equal(measured.text, 'Signed in as saved-user')
      assert.ok(
        measured.copyHeight <= 2 * measured.lineHeight + 1,
        `"Signed in as saved-user" took ${String(measured.copyHeight)}px — more than two ${String(measured.lineHeight)}px lines`,
      )
      assert.equal(measured.accountLines, 1, 'the account name must not split across lines')
      assert.equal(measured.forgetLines, 1, 'the forget label must stay on one line')
      // One forget action, one look: the kit ghost button with the same label
      // the connected controls use, stacked under the copy rather than beside it.
      assert.equal(measured.visibleForgetActions, 1, 'offer one forget action, not two')
      assert.equal(measured.forgetText, 'Forget saved login')
      assert.match(measured.forgetClass, /\bui-btn\b/)
      assert.match(measured.forgetClass, /\bui-btn-ghost\b/)
      assert.ok(measured.forgetTop >= measured.copyBottom - 1, 'forget action sits under the copy')
      assert.ok(measured.forgetRight <= measured.detailsRight + 1, 'forget action fits the card')
      if (width <= 160) {
        // The icon-column indent is dropped where the rail cannot spare it.
        assert.equal(measured.detailsPaddingLeft, measured.headerPaddingLeft)
      }
      await saveElementScreenshot(
        '.vnc-device.is-selected',
        `vnc-saved-login-details-${String(width)}.png`,
      )
    })
  }
})
