const SHRINKING_FOOTER_ITEMS = '.footer-model-host, .footer-branch-host, .footer-usage-group'

function footerNaturalWidth(footer: HTMLElement): number {
  const items = footer.querySelectorAll<HTMLElement>(SHRINKING_FOOTER_ITEMS)
  const previousFlex = [...items].map((el) => el.style.flex)

  // The pickers lay out from a zero basis (input-bar.css), so measure each at
  // its own width rather than at whatever share of the room it was given.
  items.forEach((el) => {
    el.style.flex = '0 0 auto'
  })

  const width = footer.scrollWidth

  items.forEach((el, index) => {
    el.style.flex = previousFlex[index] ?? ''
  })
  return width
}

function footerNeedsCompact(footer: HTMLElement): boolean {
  return footerNaturalWidth(footer) > footer.clientWidth
}

/** Collapse footer controls when cramped controls would overlap. */
export function bindFooterCompactLayout(
  footer: HTMLElement,
  onChange?: (compact: boolean) => void,
): {
  isCompact: () => boolean
  destroy: () => void
} {
  let compact = footer.classList.contains('is-compact')
  let frame = 0

  const sync = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const nextCompact = footerNeedsCompact(footer)
      footer.classList.toggle('is-compact', nextCompact)
      if (nextCompact !== compact) {
        compact = nextCompact
        onChange?.(compact)
      }
    })
  }

  const observer = new ResizeObserver(sync)
  observer.observe(footer)
  // Watch the controls too: a control that appears, disappears or changes size
  // (a font or UI-scale change) moves the natural width.
  for (const control of footer.children) observer.observe(control)
  const inputBar = footer.closest('#input-bar')
  if (inputBar) observer.observe(inputBar)
  // No box resizes when a label's text changes after mount (the model name, the
  // branch loaded asynchronously): the footer is sized by the composer, and a
  // host already squeezed to its share keeps that width while its label clips.
  // Only the DOM change itself says the natural width moved, so re-measure on
  // any text or `hidden` change under the footer. This covers every writer
  // without each one having to know about the footer. `sync` coalesces bursts
  // into one measurement per frame. Measuring writes only inline `style`, and
  // compacting only the footer's `class`; neither is watched, so a
  // measurement cannot re-trigger this observer.
  const mutations = new MutationObserver(sync)
  mutations.observe(footer, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden'],
  })
  window.addEventListener('resize', sync, { passive: true })
  sync()

  return {
    isCompact: () => footer.classList.contains('is-compact'),
    destroy: (): void => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', sync)
    },
  }
}
