const SHRINKING_FOOTER_ITEMS =
  '.footer-model-host, .footer-branch-host, .footer-export, .footer-usage-group'

function footerNaturalWidth(footer: HTMLElement): number {
  const items = footer.querySelectorAll<HTMLElement>(SHRINKING_FOOTER_ITEMS)
  const prev = [...items].map((el) => el.style.flexShrink)
  items.forEach((el) => {
    el.style.flexShrink = '0'
  })
  const width = footer.scrollWidth
  items.forEach((el, index) => {
    el.style.flexShrink = prev[index] ?? ''
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
      footer.classList.remove('is-compact')
      const nextCompact = footerNeedsCompact(footer)
      if (nextCompact) footer.classList.add('is-compact')
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
