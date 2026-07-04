import { el, on } from '../dom/helpers.ts'
import { moreHorizontalIcon } from '../dom/icons.ts'

export interface FooterOverflowItem {
  label: string
  onClick: () => void
  hidden?: () => boolean
}

export function mountFooterOverflow(
  root: HTMLElement,
  items: FooterOverflowItem[],
): { update: () => void; destroy: () => void } {
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
    moreHorizontalIcon('ui-icon ui-icon-sm'),
  )
  const menu = el('div', { class: 'footer-overflow-menu', role: 'menu', hidden: '' })
  wrap.append(trigger, menu)
  root.append(wrap)

  let open = false
  const cleanups: Array<() => void> = []

  function setOpen(next: boolean): void {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) menu.removeAttribute('hidden')
    else menu.setAttribute('hidden', '')
  }

  function renderMenu(): void {
    const visibleItems = items.filter((item) => !item.hidden?.())
    wrap.hidden = visibleItems.length === 0
    if (visibleItems.length === 0) setOpen(false)
    menu.replaceChildren(
      ...visibleItems.map(({ label, onClick }) => {
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
  trigger.addEventListener('click', () => {
    renderMenu()
    if (!wrap.hidden) setOpen(!open)
  })

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
    update: renderMenu,
    destroy: (): void => {
      cleanups.forEach((u) => {
        u()
      })
    },
  }
}
