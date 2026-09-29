/** Keeps the eager, desktop-sized demo fitted to its clipped hero panel. */
;(function heroDemo() {
  var host = document.querySelector('.hero-demo')
  if (!host) return
  var frame = host.querySelector('.hero-demo-frame')
  // A hidden overlay means click-to-interact is parked (see index.html). The
  // demo then stays a showcase — inert, with "Open demo fullscreen" carrying
  // anyone who wants to drive it. Everything below stays wired for the day the
  // attribute comes off.
  var activate = host.querySelector('.hero-demo-activate:not([hidden])')
  var FRAME_HEIGHT = 800
  var mobile = window.matchMedia('(max-width: 760px)')

  function setInteractive(interactive) {
    if (!frame || !activate) return
    host.classList.toggle('is-interactive', interactive)
    activate.setAttribute('aria-pressed', interactive ? 'true' : 'false')
    frame.tabIndex = interactive ? 0 : -1
    if (interactive) {
      frame.removeAttribute('aria-hidden')
      frame.focus({ preventScroll: true })
    } else {
      frame.setAttribute('aria-hidden', 'true')
      if (document.activeElement === frame) activate.focus({ preventScroll: true })
    }
  }

  function fit() {
    var width = host.clientWidth
    var height = host.clientHeight
    if (!width || !height) return

    var byWidth = width / 1280
    var byHeight = height / FRAME_HEIGHT
    // The panel's aspect-ratio matches this frame, so the two fits agree to
    // within the browser's integer rounding of clientWidth/clientHeight.
    // Cover-fitting that fraction of a pixel keeps the app bled to the panel's
    // rounded edge, so its corners are the only ones on show. A real ratio
    // mismatch — only reachable by editing the panel — contain-fits instead,
    // since spare panel background beats cropping app chrome.
    var matched = Math.abs(byWidth - byHeight) < 0.005
    var scale = matched ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight)
    var left = (width - 1280 * scale) / 2
    var top = (height - FRAME_HEIGHT * scale) / 2

    host.style.setProperty('--hero-demo-scale', String(scale))
    host.style.setProperty('--hero-demo-left', String(left) + 'px')
    host.style.setProperty('--hero-demo-top', String(top) + 'px')
  }

  function syncAvailability() {
    if (!frame) return

    if (mobile.matches) {
      setInteractive(false)
      frame.removeAttribute('src')
      return
    }

    var source = frame.getAttribute('data-src')
    if (source && !frame.hasAttribute('src')) frame.setAttribute('src', source)
    fit()
  }

  syncAvailability()
  window.addEventListener('resize', fit)
  mobile.addEventListener('change', syncAvailability)

  if (frame && activate) {
    activate.addEventListener('click', function activateDemo() {
      setInteractive(true)
    })
    host.addEventListener('mouseleave', function releaseDemo() {
      setInteractive(false)
    })
    document.addEventListener('pointerdown', function releaseDemoFromOutside(event) {
      if (host.classList.contains('is-interactive') && !host.contains(event.target)) {
        setInteractive(false)
      }
    })
    function releaseDemoWithEscape(event) {
      if (event.key === 'Escape') setInteractive(false)
    }
    document.addEventListener('keydown', releaseDemoWithEscape)
    function bindFrameEscapeKey() {
      try {
        frame.contentWindow.addEventListener('keydown', releaseDemoWithEscape)
      } catch {
        // The published demo is same-origin. Pointer-leave and outside-click
        // release remain available if a custom host changes that.
      }
    }
    frame.addEventListener('load', bindFrameEscapeKey)
    bindFrameEscapeKey()
  }
})()
