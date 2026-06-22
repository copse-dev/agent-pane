import { el, on } from '../dom/helpers.ts'

export function mountFooterOverflow(
  root: HTMLElement,
  items: Array<{ label: string; onClick: () => void }>,
): { destroy: () => void } {
  const wrap = el('div', { class: 'footer-overflow' })
  const trigger = el(
    'button',
    {
      type: 'button',
      class: 'footer-overflow-trigger',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': 'More footer actions',
    },
    '⋯',
  )
  const menu = el('div', { class: 'footer-overflow-menu', role: 'menu', hidden: '' })
  wrap.append(trigger, menu)
  root.append(wrap)

  let open = false
  const cleanups: Array<() => void> = []

  function setOpen(next: boolean) {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) menu.removeAttribute('hidden')
    else menu.setAttribute('hidden', '')
  }

  function renderMenu() {
    menu.replaceChildren(
      ...items.map(({ label, onClick }) => {
        const item = el(
          'button',
          { type: 'button', class: 'footer-overflow-item', role: 'menuitem' },
          label,
        )
        item.addEventListener('click', () => {
          onClick()
          setOpen(false)
        })
        return item
      }),
    )
  }

  renderMenu()
  trigger.addEventListener('click', () => setOpen(!open))

  cleanups.push(
    on(document, 'click', (e) => {
      if (!open) return
      if (!wrap.contains(e.target as Node)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }),
  )

  return {
    destroy: () => cleanups.forEach((u) => u()),
  }
}
