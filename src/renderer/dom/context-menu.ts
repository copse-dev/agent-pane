import { el } from './helpers.ts'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
}

/** Dismiss any open context menu (and its dismiss listeners). */
let dismissOpenContextMenu: (() => void) | null = null

/**
 * Fixed-position right-click menu. One menu at a time — opening another
 * (or clicking outside / Escape / blur) dismisses the current one.
 */
export function showContextMenu(
  clientX: number,
  clientY: number,
  items: readonly ContextMenuItem[],
): void {
  dismissOpenContextMenu?.()
  if (items.length === 0) return

  const buttons = items.map((item) => {
    const btn = el(
      'button',
      { type: 'button', class: 'context-menu-item', role: 'menuitem' },
      item.label,
    )
    if (item.disabled) btn.disabled = true
    // Prefer mousedown + preventDefault (same pattern as the skill picker) so
    // selecting an item that mounts a focused rename input does not lose that
    // focus to the activating click/blur sequence before onSelect runs.
    // Keep a click fallback for jsdom/component tests that call `button.click()`.
    let selected = false
    const select = (): void => {
      if (selected || item.disabled) return
      selected = true
      dismiss()
      item.onSelect()
    }
    btn.addEventListener('mousedown', (e) => {
      if (item.disabled) return
      e.preventDefault()
      e.stopPropagation()
      select()
    })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      select()
    })
    return btn
  })

  const menu = el('div', { class: 'context-menu', role: 'menu' }, ...buttons)
  menu.style.left = `${String(clientX)}px`
  menu.style.top = `${String(clientY)}px`

  const dismiss = (): void => {
    menu.remove()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', dismiss)
    if (dismissOpenContextMenu === dismiss) dismissOpenContextMenu = null
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (menu.contains(e.target instanceof Node ? e.target : null)) return
    dismiss()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismiss()
  }

  document.body.append(menu)
  dismissOpenContextMenu = dismiss
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', dismiss)

  // Keep the menu inside the viewport when opened near an edge.
  const rect = menu.getBoundingClientRect()
  const pad = 4
  let left = clientX
  let top = clientY
  if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad
  if (left < pad) left = pad
  if (top < pad) top = pad
  menu.style.left = `${String(left)}px`
  menu.style.top = `${String(top)}px`
}

/** Test / teardown helper — dismisses any open menu. */
export function dismissContextMenu(): void {
  dismissOpenContextMenu?.()
}
