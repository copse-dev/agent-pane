/**
 * `prepareE2eScreenshot` pins `#app` to `min(800, window.innerHeight)` with
 * `overflow: hidden` so reference shots are a fixed size whatever window the
 * runner gives us. That clamp runs *after* a spec has scrolled its subject into
 * view, and nothing re-scrolls afterwards — so on a runner whose window is
 * taller than the pinned shell, the clamp cuts away the part of the scrollport
 * the subject was centred in, and the capture is truncated.
 *
 * Measured in Chromium against the settings scrollport, centring a 204px
 * element and then clamping the shell to 800px:
 *
 *   window 800px  -> 204px captured   (clamp is a no-op)
 *   window 900px  -> 204px captured
 *   window 1080px -> 145px captured, 159px behind the sticky action bar
 *   window 1440px ->  74px captured, 230px behind the sticky action bar
 *
 * Which is why `settings-automations.png` came back 686x95 instead of 686x219
 * with its schedule row gone, while the spec that takes it still passed: the
 * row was in the DOM and asserted on, just outside the pinned shell by the time
 * the shot was taken. Re-centring after the clamp restored the full 204px at
 * every window height above.
 */

/**
 * Runs **in the browser**. Returns whether `element` needs re-centring because
 * the pinned shell no longer wholly contains it.
 *
 * Deliberately a no-op for anything already inside the shell: most reference
 * shots frame their subject exactly as their spec left it, and scrolling those
 * would rewrite baselines that were never wrong.
 *
 * Must stay **free of module scope**: WDIO ships this to the page as
 * `fn.toString()`, so a reference to anything declared outside the body is a
 * `ReferenceError` there and nowhere else. `capture-framing.test.ts` pins that.
 */
export function recentreClippedCapture(element: Element, shellSelector: string): boolean {
  const shell = document.querySelector(shellSelector)
  if (!(shell instanceof HTMLElement)) return false
  if (!(element instanceof HTMLElement)) return false

  const shellRect = shell.getBoundingClientRect()
  if (shellRect.height === 0) return false

  const rect = element.getBoundingClientRect()
  // Wholly inside the pinned shell: the spec's own framing stands.
  if (rect.top >= shellRect.top && rect.bottom <= shellRect.bottom) return false

  // An element taller than the shell can never fit; centring it is still the
  // most faithful thing to do, since that is what the specs themselves ask for.
  element.scrollIntoView({ block: 'center', inline: 'nearest' })
  return true
}
