import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'

// Structural invariant for the issue-#1914 bug class: window drag regions
// (`-webkit-app-region: drag` — the titlebar, or the full-window #welcome
// surface) silently swallow real clicks on anything painted above them without
// an explicit opt-out. WebdriverIO's synthetic clicks BYPASS drag regions, so a
// click-based test can pass while every real click is eaten — which is exactly
// what happened to the New Project dialog. So instead of clicking, this spec
// recomputes what Electron computes: it walks every app-region-annotated
// element in tree order (matching the union/subtract-in-paint-order semantics
// drag regions are built with) and asserts no interactive control inside an
// open dialog resolves to "drag" at its center point.
//
// The `dialog { -webkit-app-region: no-drag }` rule in forms.css is the
// blanket opt-out this spec locks in.

interface RegionCheck {
  ok: boolean
  violations: string[]
}

/** Runs in the page. Mirrors Electron's draggable-region computation. */
function checkDialogRegions(rootSelector: string): RegionCheck {
  const regionOf = (element: Element): string => {
    const style = getComputedStyle(element)
    return (
      style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region')
    ).trim()
  }
  // Every annotated element with a visible rect, in tree (≈ paint) order.
  const annotated: { rect: DOMRect; drag: boolean }[] = []
  for (const element of document.querySelectorAll('*')) {
    const value = regionOf(element)
    if (value !== 'drag' && value !== 'no-drag') continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    annotated.push({ rect, drag: value === 'drag' })
  }
  const effectiveAt = (x: number, y: number): 'drag' | 'none' => {
    let state: 'drag' | 'none' = 'none'
    for (const entry of annotated) {
      const inside =
        x >= entry.rect.left &&
        x <= entry.rect.right &&
        y >= entry.rect.top &&
        y <= entry.rect.bottom
      if (inside) state = entry.drag ? 'drag' : 'none'
    }
    return state
  }
  const root = document.querySelector(rootSelector)
  if (!root) return { ok: false, violations: [`missing root ${rootSelector}`] }
  const describe = (element: Element): string => {
    const id = element.id ? `#${element.id}` : ''
    const cls =
      element.className && typeof element.className === 'string'
        ? `.${element.className.split(/\s+/).filter(Boolean).join('.')}`
        : ''
    return `${element.tagName.toLowerCase()}${id}${cls}`
  }
  const violations: string[] = []
  const targets = [
    root,
    ...root.querySelectorAll(
      'button, input, select, textarea, a[href], summary, label, [role="button"]',
    ),
  ]
  for (const element of targets) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (effectiveAt(rect.left + rect.width / 2, rect.top + rect.height / 2) === 'drag') {
      violations.push(describe(element))
    }
  }
  return { ok: violations.length === 0, violations }
}

async function assertNoDragViolations(rootSelector: string): Promise<void> {
  const result = (await browser.execute(checkDialogRegions, rootSelector)) as RegionCheck
  if (!result.ok) {
    throw new Error(`drag-region violations in ${rootSelector}: ${result.violations.join(', ')}`)
  }
}

describe('dialog drag-region invariant (issue #1914 class)', () => {
  before(async () => {
    seedOnboardingFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('the assertion itself works: computed app-region is readable', async () => {
    const probe = await browser.execute(() => {
      const el = document.createElement('div')
      el.style.setProperty('-webkit-app-region', 'no-drag')
      document.body.append(el)
      const style = getComputedStyle(el)
      const value = (
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region')
      ).trim()
      el.remove()
      return value
    })
    // A loud failure here means the whole spec needs a different mechanism —
    // not that the app regressed.
    expect(probe).toBe('no-drag')
  })

  it('the onboarding dialog is click-safe (its drag header excepted)', async () => {
    const overlay = await $('#onboarding-dialog')
    await overlay.waitForDisplayed({ timeout: 30_000 })
    await assertNoDragViolations('#onboarding-dialog')
  })

  it('the New Project dialog over the full-window welcome drag surface is click-safe', async function () {
    this.timeout(60_000)
    // Dismiss onboarding onto the welcome screen — the whole screen is a drag
    // region there, the exact construction that ate #1914's clicks.
    await $('#onboarding-skip').click()
    const newProjectBtn = await $('.welcome-new-btn')
    await newProjectBtn.waitForClickable({ timeout: 15_000 })
    await newProjectBtn.click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#new-project-dialog')?.open === true,
        ),
      { timeout: 15_000, timeoutMsg: 'New Project dialog did not open' },
    )
    await assertNoDragViolations('#new-project-dialog')
    await browser.keys('Escape')
  })

  it('every open dialog passes the sweep', async () => {
    // Generic guard for dialogs added later: anything open right now is checked.
    const openDialogs = (await browser.execute(() =>
      [...document.querySelectorAll('dialog[open]')].map((d) => `#${d.id}`),
    )) as string[]
    for (const selector of openDialogs) {
      await assertNoDragViolations(selector)
    }
  })
})
