import { $, browser } from '@wdio/globals'

const ACTIVE_ADDRESS = '.browser-tab-panel.is-active .browser-url-input'

/**
 * Navigate the active Browser tab the way a user does: type the address and
 * press Enter. Enter is the submit path at every pane width. The text Go
 * button hides when the toolbar is narrow (360px or less; see
 * `.browser-go-btn` in layout.css), so a spec that clicks it breaks whenever
 * the pane is narrow. Enter and Go both call the same `navigateTab`.
 */
export async function navigateActiveBrowserTab(url: string): Promise<void> {
  const input = $(ACTIVE_ADDRESS)
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(url)
  await browser.keys('Enter')
}
