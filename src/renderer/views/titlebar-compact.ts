export const TITLEBAR_COMPACT_CLASS = 'is-titlebar-compact'

function titlebarNeedsCompact(titlebar: HTMLElement): boolean {
  const wasCompact = titlebar.classList.contains(TITLEBAR_COMPACT_CLASS)
  const overflowed = [...titlebar.querySelectorAll('[data-portrait-overflow]')]
  const controls = titlebar.querySelector<HTMLElement>('.titlebar-panel-controls')
  const alignment = controls?.style.justifyContent ?? ''
  if (controls) controls.style.justifyContent = 'flex-start'
  overflowed.forEach((button) => {
    button.removeAttribute('data-portrait-overflow')
  })
  titlebar.classList.remove(TITLEBAR_COMPACT_CLASS)
  const needsCompact = titlebar.scrollWidth > titlebar.clientWidth
  titlebar.classList.toggle(TITLEBAR_COMPACT_CLASS, wasCompact)
  overflowed.forEach((button) => {
    button.setAttribute('data-portrait-overflow', '')
  })
  if (controls) controls.style.justifyContent = alignment
  return needsCompact
}

/** Collapse secondary titlebar labels whenever the full controls would overflow. */
export function bindTitlebarCompactLayout(
  titlebar: HTMLElement,
  observedContents: readonly HTMLElement[],
): () => void {
  let frame = 0

  const sync = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      titlebar.classList.toggle(TITLEBAR_COMPACT_CLASS, titlebarNeedsCompact(titlebar))
    })
  }

  const observer = new ResizeObserver(sync)
  observer.observe(titlebar)
  observedContents.forEach((element) => {
    observer.observe(element)
  })
  window.addEventListener('resize', sync, { passive: true })
  sync()

  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    window.removeEventListener('resize', sync)
    titlebar.classList.remove(TITLEBAR_COMPACT_CLASS)
  }
}
