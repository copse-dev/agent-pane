export function installComposerFocus() {
  const viewport = window.visualViewport
  const header = document.querySelector('.topbar')
  let frame = 0

  function updateViewport() {
    const height = viewport?.height ?? window.innerHeight
    const offset = viewport?.offsetTop ?? 0
    const style = document.documentElement.style
    style.setProperty('--viewport-height', `${height}px`)
    style.setProperty('--viewport-offset', `${offset}px`)
    style.setProperty('--keyboard-inset', `${Math.max(0, window.innerHeight - height)}px`)
  }

  function reveal(input) {
    if (!input || !['message', 'new-message'].includes(input.id) || input.closest('[hidden]'))
      return
    const button = input.form?.querySelector('button[type="submit"]')
    if (!button) return
    const top = (viewport?.offsetTop ?? 0) + header.getBoundingClientRect().height + 12
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12
    const inputTop = input.getBoundingClientRect().top
    const buttonBottom = button.getBoundingClientRect().bottom
    const delta = buttonBottom > bottom ? buttonBottom - bottom : Math.min(0, inputTop - top)
    if (delta) window.scrollBy({ top: delta, behavior: 'instant' })
  }

  function scheduleReveal() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => reveal(document.activeElement))
  }

  for (const id of ['message', 'new-message']) {
    document.getElementById(id).addEventListener('focus', scheduleReveal)
  }
  viewport?.addEventListener('resize', () => {
    updateViewport()
    scheduleReveal()
  })
  viewport?.addEventListener('scroll', updateViewport)
  window.addEventListener('resize', () => {
    updateViewport()
    scheduleReveal()
  })
  updateViewport()

  return {
    revealComposer: scheduleReveal,
    focusComposer(input) {
      if (input.closest('[hidden]')) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
      scheduleReveal()
    },
  }
}
