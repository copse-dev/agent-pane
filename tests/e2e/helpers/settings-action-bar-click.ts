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
 * again.
 *
 * So catch the interception instead of anticipating it: let the click run, and
 * only when WebDriver reports *this* bar covering the target, scroll clear and
 * retry once. Clicks that were going to succeed are untouched.
 *
 * Narrowness comes from geometry, not from reading the error. The retry happens
 * only when this bar demonstrably covers the click point of an element inside
 * the settings scrollport, the element is not one of the bar's own buttons, and
 * the scrollport actually had somewhere to move; and then exactly once. Every
 * other covered-element failure moves nothing and fails as it should — this is
 * not a blanket "retry the click somewhere else".
 *
 * Identifying the culprit from the message was tried first and does not work:
 * WebDriver names the topmost element, which is frequently one of the bar's own
 * children rather than the bar. See {@link isClickIntercepted}.
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
 * Is this WebDriver's covered-element failure at all?
 *
 * Deliberately does *not* try to name the culprit from the message. WebDriver
 * reports the topmost element at the point, which for this bar is as often one
 * of its own children as the `.settings-buttons` box:
 *
 *   Other element would receive the click: <button id="settings-cancel">
 *
 * An earlier version required the message to contain `settings-buttons`, and so
 * declined that case and rethrew — `settings-automations.e2e.ts` failed in CI
 * for exactly this reason. Widening the substring would not have fixed it
 * either: the bar's Save button renders as a bare `<button type="submit">`,
 * carrying nothing to match on.
 *
 * Whether this bar is really the cause is therefore decided by geometry, in
 * {@link scrollClearOfSettingsActionBar}, which answers it directly instead of
 * guessing from text.
 */
export function isClickIntercepted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('element click intercepted')
}

/**
 * Wrap the element-scoped `click` so a control parked under Settings' sticky
 * action bar is scrolled clear and the click retried once. Installed from
 * `wdio.conf.ts`'s `before()`.
 *
 * Deliberately reactive, not pre-emptive. An earlier version measured before
 * *every* click in the suite; that put a `browser.execute` round-trip in front
 * of several thousand clicks that never needed one, and the timing shift was
 * enough to flip `git-changes.e2e.ts` from green to red (shard 3 passed on the
 * same branch while this helper was inert, and failed once it worked). Paying
 * the cost only on the failure keeps every passing click byte-for-byte as it
 * was, so the helper cannot perturb a spec it has no business touching.
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
        return await origClick.apply(this, args)
      } catch (error) {
        if (!isClickIntercepted(error)) throw error
        let scrolled = false
        try {
          scrolled =
            (await session.execute(
              scrollClearOfSettingsActionBar,
              this,
              ACTION_BAR_CLEARANCE_PX,
            )) === true
        } catch (measureError) {
          // Best effort. Say so out loud rather than swallowing: a silent catch
          // here once hid a `ReferenceError` from module scope leaking into the
          // shipped function, which looked exactly like "the scroll did nothing".
          console.warn(
            '[settings-action-bar-click] could not measure the click point:',
            measureError,
          )
          throw error
        }
        // The scroll is the whole warrant for retrying. It returns true only
        // when this bar really covered the click point *and* the scrollport had
        // somewhere to go, so every other covered-element failure — a modal
        // backdrop, a toast, an overlay, or this bar with nothing left to
        // scroll — arrives here, moves nothing, and fails as it should.
        if (!scrolled) throw error
        // One retry only.
        return await origClick.apply(this, args)
      }
    },
    true,
  )
}
