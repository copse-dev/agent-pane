import { $, browser } from '@wdio/globals'

/** Change theme through the same persisted settings surface a user uses. */
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

/**
 * The computed value `property: var(token)` resolves to in the live theme, read
 * off a throwaway probe so it is serialised exactly like the element it is
 * compared against (Chromium prints a `color-mix()` result as `color(srgb …)`).
 */
export async function tokenColour(
  token: string,
  property: 'color' | 'background-color' | 'border-top-color' = 'color',
): Promise<string> {
  return browser.execute(
    (name, prop) => {
      const probe = document.createElement('span')
      probe.style.setProperty(prop, `var(${name})`)
      document.body.append(probe)
      const value = getComputedStyle(probe).getPropertyValue(prop)
      probe.remove()
      return value
    },
    token,
    property,
  )
}
