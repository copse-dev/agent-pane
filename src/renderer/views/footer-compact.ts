const SHRINKING_FOOTER_ITEMS = '.footer-model-host, .footer-branch-host, .footer-usage-group'

function footerNaturalWidth(footer: HTMLElement): number {
  const items = footer.querySelectorAll<HTMLElement>(SHRINKING_FOOTER_ITEMS)
  const previousShrink = [...items].map((el) => el.style.flexShrink)
  const usage = footer.querySelector<HTMLElement>('.footer-usage')
  const previousUsageDisplay = usage?.style.display

  items.forEach((el) => {
    el.style.flexShrink = '0'
  })
  if (usage) usage.style.display = 'inline'

  const width = footer.scrollWidth

  items.forEach((el, index) => {
    el.style.flexShrink = previousShrink[index] ?? ''
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
