const SHRINKING_FOOTER_ITEMS = '.footer-model-host, .footer-branch-host, .footer-usage-group'

function footerNaturalWidth(footer: HTMLElement): number {
  const items = footer.querySelectorAll<HTMLElement>(SHRINKING_FOOTER_ITEMS)
  const previousFlex = [...items].map((el) => el.style.flex)
  const usage = footer.querySelector<HTMLElement>('.footer-usage')
  const previousUsageDisplay = usage?.style.display

  // The pickers lay out from a zero basis (input-bar.css), so measure each at
  // its own width rather than at whatever share of the room it was given.
  items.forEach((el) => {
    el.style.flex = '0 0 auto'
  })
  if (usage) usage.style.display = 'inline'

  const width = footer.scrollWidth

  items.forEach((el, index) => {
    el.style.flex = previousFlex[index] ?? ''
  })
  if (usage) usage.style.display = previousUsageDisplay ?? ''
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
  // The footer's own box is sized by the composer, so it does not resize when
  // the model or branch label fills in after mount. Watch the controls too, or
  // the footer keeps the roomy layout it measured while they were still empty
  // and squeezes the branch chip to a character instead of going compact.
  // Measuring restores every style it touches before layout. Toggling
  // `is-compact` does resize the usage group, but the re-run measures the same
  // natural width (usage forced visible), so it settles after one pass.
  for (const control of footer.children) observer.observe(control)
  const inputBar = footer.closest('#input-bar')
  if (inputBar) observer.observe(inputBar)
  window.addEventListener('resize', sync, { passive: true })
  sync()

  return {
    isCompact: () => footer.classList.contains('is-compact'),
    destroy: (): void => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', sync)
    },
  }
}
