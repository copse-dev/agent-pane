/** Keeps the eager, desktop-sized demo fitted to its clipped hero panel. */
;(function heroDemo() {
  var host = document.querySelector('.hero-demo')
  if (!host) return
  var frame = host.querySelector('.hero-demo-frame')
  var activate = host.querySelector('.hero-demo-activate')
  var FRAME_HEIGHT = 800

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

    // Keep the complete desktop viewport visible. The surrounding panel uses
    // the same dark treatment as the app, so any spare space at unusually wide
    // or tall aspect ratios reads as a frame instead of cropping app chrome.
    var scale = Math.min(width / 1280, height / FRAME_HEIGHT)
    var left = (width - 1280 * scale) / 2
    var top = (height - FRAME_HEIGHT * scale) / 2

    host.style.setProperty('--hero-demo-scale', String(scale))
    host.style.setProperty('--hero-demo-left', String(left) + 'px')
    host.style.setProperty('--hero-demo-top', String(top) + 'px')
  }

  fit()
  window.addEventListener('resize', fit)

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
