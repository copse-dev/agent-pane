import { $, browser } from '@wdio/globals'

/**
 * Change theme through Settings → Appearance, the persisted surface a user
 * uses. Mutating `data-theme` directly has intermittently dropped painted
 * glyphs from the next capture; saving through Settings gives Chromium a
 * stable render first.
 */
export async function switchTheme(theme: 'light' | 'dark'): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
  await browser.execute((next) => {
    const select = document.querySelector<HTMLSelectElement>('select[name="theme"]')
    if (!select) return
    select.value = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, theme)
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      browser.execute((next) => document.documentElement.dataset['theme'] === next, theme),
    { timeout: 10_000, timeoutMsg: `expected the ${theme} theme to apply` },
  )
}
