/**
 * Swaps the hero screenshot for the live browser demo.
 *
 * The demo is the real renderer against a mock API, published by
 * `.github/workflows/pages.yml` under `/demo/main/`. It boots the `landing`
 * scenario, which types a recorded prompt into the composer and streams the
 * recorded answer back through the app's own transcript — so the hero shows the
 * interface working rather than a picture of it having worked.
 *
 * Everything here is additive. The screenshot is in the markup, keeps its place
 * in the layout, and stays put unless every condition for the live version is
 * met: scripting, a wide enough viewport, no reduced-motion preference, and an
 * iframe that actually loads in time. Anything less and the page is exactly the
 * page it was before.
 */
;(function heroDemo() {
  var host = document.querySelector('.hero-demo')
  if (!host) return
  var src = host.getAttribute('data-demo-src')
  if (!src) return

  // The demo renders a desktop three-pane layout. Below this it would be a
  // postage stamp, and the screenshot reads better.
  var MIN_VIEWPORT = 900
  // The iframe renders at a desktop viewport and is scaled down to fit.
  var FRAME_WIDTH = 1280
  var FRAME_HEIGHT = 800
  // Give up and keep the poster if the demo has not painted by now.
  var LOAD_TIMEOUT_MS = 12000

  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (motionQuery.matches) return
  if (window.innerWidth < MIN_VIEWPORT) return

  var frame = document.createElement('iframe')
  frame.className = 'hero-demo-frame'
  frame.src = src
  frame.title = 'Live demo of Copse answering a question about its own codebase'
  frame.setAttribute('loading', 'lazy')
  // First-party content from this same origin, so `allow-same-origin` costs no
  // isolation that the browser was giving us anyway — and without it the frame
  // gets an opaque origin, which blocks its own web fonts on CORS grounds and
  // stops it constructing the editor's workers. Everything else stays denied:
  // no forms, popups, downloads, top-level navigation, or pointer lock.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  // Decorative: the walkthrough drives itself, and a scaled-down app is not a
  // usable control surface. The caption link goes to the real thing.
  frame.setAttribute('tabindex', '-1')
  frame.setAttribute('aria-hidden', 'true')
  frame.width = String(FRAME_WIDTH)
  frame.height = String(FRAME_HEIGHT)

  function fit() {
    var height = host.clientHeight
    if (!height) return
    // Scale to the poster's height and let the extra width crop, matching the
    // screenshot's `object-position: left center`.
    host.style.setProperty('--hero-demo-scale', String(height / FRAME_HEIGHT))
  }

  var settled = false

  function fallBack() {
    if (settled) return
    settled = true
    window.clearInterval(poll)
    frame.remove()
  }

  function reveal() {
    if (settled) return
    settled = true
    window.clearInterval(poll)
    fit()
    host.classList.add('is-live')
  }

  /**
   * Has the demo actually rendered? `load` alone does not answer this: a 404 or
   * an error page fires `load` too, and revealing on that would trade the
   * screenshot for a blank panel. The composer only exists once the renderer has
   * mounted, so its presence is the honest signal — and it is readable because
   * the frame is same-origin.
   */
  function mounted() {
    try {
      var doc = frame.contentDocument
      return Boolean(doc && doc.querySelector('.prompt-input'))
    } catch {
      // Unreadable means genuinely cross-origin, which our own /demo/ path is
      // not — so this is not the demo we asked for.
      return false
    }
  }

  var deadline = Date.now() + LOAD_TIMEOUT_MS
  var poll = window.setInterval(function check() {
    if (settled) return
    if (mounted()) reveal()
    else if (Date.now() > deadline) fallBack()
  }, 150)

  frame.addEventListener('error', fallBack)

  host.appendChild(frame)
  fit()
  window.addEventListener('resize', fit)
})()
