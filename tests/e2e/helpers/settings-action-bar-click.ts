/**
 * Settings' Save/Cancel bar is `position: sticky` at the bottom of the
 * `.settings-content` scrollport. It paints a translucent wash — see
 * `docs/ui-taste.md` — but it still hit-tests its whole box, so a control that
 * has scrolled underneath it is visible yet unclickable:
 *
 *   element click intercepted: Element <summary class="plugin-settings-summary">
 *   is not clickable at point (712, 785).
 *   Other element would receive the click: <div class="settings-buttons">
 *
 * WebDriver does not rescue itself here. Its click algorithm scrolls only when
 * the element is *out of view*, and a control under the bar is in view — so it
 * skips straight to the in-view centre point, finds the bar topmost there, and
 * throws. `scroll-padding-bottom` on the scrollport cannot help either: nothing
 * scrolls, so nothing consults the reserve.
 *
 * The specs cannot reliably pre-empt this themselves. Most already call
 * `scrollIntoView({ block: 'center' })` on the *row*, which centres the row and
 * leaves a control near its bottom edge still under the bar; and rows grow
 * after the scroll as plugin chips and folds render, pushing the target down
 * again. So correct it at the moment of truth instead: immediately before the
 * click, once layout has settled.
 *
 * Deliberately narrow. It moves the scrollport only when the element really is
 * a Settings control whose click point the bar really does cover, and it never
 * touches the bar's own buttons. Every other interception still fails the way
 * it should — this is not a blanket "retry the click somewhere else".
 */

/** Margin above the bar so sub-pixel rounding cannot put the target back under it. */
export const ACTION_BAR_CLEARANCE_PX = 8

/**
 * Runs **in the browser**. Scrolls `element` clear of the Settings action bar
 * when the bar covers its click point. Returns whether the scrollport moved.
 *
 * Must stay **free of module scope**: WDIO ships this to the page as
 * `fn.toString()`, so a reference to anything declared outside the body — a
 * sibling const, an imported helper — is a `ReferenceError` there and nowhere
 * else. That is why the clearance arrives as an argument rather than reading
 * {@link ACTION_BAR_CLEARANCE_PX} directly. `settings-action-bar-click.test.ts`
 * pins this by re-parsing the function the way WDIO does.
 */
export function scrollClearOfSettingsActionBar(element: Element, clearancePx: number): boolean {
  const scroller = element.closest('.settings-content')
  if (!(scroller instanceof HTMLElement)) return false
  const bar = scroller.querySelector(':scope > .settings-buttons')
  if (!(bar instanceof HTMLElement)) return false
  // Save and Cancel live *in* the bar; they are meant to be clicked where they are.
  if (bar.contains(element)) return false

  const barRect = bar.getBoundingClientRect()
  if (barRect.height === 0) return false

  const rect = element.getBoundingClientRect()
  // WebDriver clicks the in-view centre point, so only an overlap that reaches
  // the centre actually intercepts. Leave a partial overlap alone: scrolling it
  // would move the page under a spec that never asked for it.
  const centreY = rect.top + rect.height / 2
  if (centreY < barRect.top) return false

  const before = scroller.scrollTop
  scroller.scrollTop = before + (rect.bottom - barRect.top) + clearancePx
  // A scrollport already at its end cannot move; the click then fails as before
  // rather than silently passing somewhere unintended.
  return scroller.scrollTop !== before
}

/** The slice of a WDIO browser this helper needs. Kept structural so unit fakes stay small. */
export type ActionBarClickSession = {
  execute: (
    script: (element: Element, clearancePx: number) => boolean,
    element: unknown,
    clearancePx: number,
  ) => Promise<unknown>
  /**
   * WDIO's supported command override. The third argument attaches the override
   * to the *element* scope, which is where `click` lives. Assigning through the
   * `@wdio/globals` Proxy would not reach the real browser — see
   * `after-test-safety.ts` for the same constraint on `deleteSession`.
   */
  overwriteCommand?: (
    name: string,
    // WDIO binds `this` to the element; keep it untyped so unit fakes stay simple.
    fn: (
      this: unknown,
      origCommand: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => unknown,
    attachToElement?: boolean,
  ) => void
}

const clickPatched = new WeakSet<object>()

/**
 * Wrap the element-scoped `click` so a control parked under Settings' sticky
 * action bar is scrolled clear first. Installed once per session from
 * `wdio.conf.ts`'s `before()`.
 */
export function installSettingsActionBarClickSafety(session: ActionBarClickSession): void {
  if (typeof session.overwriteCommand !== 'function') return
  if (clickPatched.has(session)) return
  clickPatched.add(session)

  session.overwriteCommand(
    'click',
    async function overwriteClick(
      this: unknown,
      origClick: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) {
      try {
        await session.execute(scrollClearOfSettingsActionBar, this, ACTION_BAR_CLEARANCE_PX)
      } catch (error) {
        // Measuring is best effort: a stale element, a closed dialog, or a page
        // without Settings must not turn into a click failure of its own. Let
        // the real click run and report the real problem.
        //
        // Say so out loud, though. A silent catch here once hid a
        // `ReferenceError` from module scope leaking into the shipped function,
        // which looked exactly like "the correction simply did not apply".
        console.warn('[settings-action-bar-click] could not measure the click point:', error)
      }
      return await origClick.apply(this, args)
    },
    true,
  )
}
