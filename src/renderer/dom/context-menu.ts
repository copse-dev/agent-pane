import { el } from './helpers.ts'
import { checkIcon } from './icons.ts'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Renders a check and marks the row current — for menus that pick a value. */
  checked?: boolean
  /** With `checked`, draws an on/off switch instead of a check, for a setting rather than a choice. */
  toggle?: boolean
  /** Muted text after the label, such as a count. */
  detail?: string
}

/** A non-interactive label that groups the items under it. */
export interface ContextMenuHeading {
  heading: string
}

/** A rule between two groups of items. */
export interface ContextMenuSeparator {
  separator: true
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuHeading | ContextMenuSeparator

const isHeading: (entry: ContextMenuEntry) => entry is ContextMenuHeading = (entry) =>
  'heading' in entry

const isSeparator: (entry: ContextMenuEntry) => entry is ContextMenuSeparator = (entry) =>
  'separator' in entry

/** Dismiss any open context menu (and its dismiss listeners). */
let dismissOpenContextMenu: (() => void) | null = null

/** The last press that closed a menu from outside it, so its own button can read the press as a toggle. */
let outsidePress: { target: Node | null; at: number } | null = null

/**
 * True when the press that is being completed into a click on `anchor` is the one
 * that just closed a menu. A button that opens a menu calls this first and returns,
 * so a second click on it closes the menu rather than closing and reopening it.
 */
export function contextMenuClosedByPressOn(anchor: Element): boolean {
  const press = outsidePress
  outsidePress = null
  return (
    press !== null &&
    press.target !== null &&
    anchor.contains(press.target) &&
    Date.now() - press.at < 1000
  )
}

/**
 * Fixed-position right-click menu. One menu at a time — opening another
 * (or clicking outside / Escape / blur) dismisses the current one.
 *
 * Appends into `document.body` by default. A menu opened from inside an
 * open `<dialog>` (e.g. the attachment preview) must instead append inside
 * that dialog: the UA renders a modal dialog in the top layer, above every
 * sibling of `<body>` regardless of z-index, so a body-level menu would be
 * painted underneath it and unclickable. Pass any node inside that dialog
 * as `withinDialog` to opt in.
 */
export function showContextMenu(
  clientX: number,
  clientY: number,
  items: readonly ContextMenuEntry[],
  withinDialog?: Element,
): void {
  dismissOpenContextMenu?.()
  if (items.every((entry) => isHeading(entry) || isSeparator(entry))) return

  const buttons = items.map((entry) => {
    if (isSeparator(entry)) return el('div', { class: 'context-menu-separator', role: 'separator' })
    if (isHeading(entry)) {
      return el('div', { class: 'context-menu-heading', role: 'presentation' }, entry.heading)
    }
    const item = entry
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'context-menu-item',
        role:
          item.checked === undefined
            ? 'menuitem'
            : item.toggle === true
              ? 'menuitemcheckbox'
              : 'menuitemradio',
        ...(item.checked === undefined ? {} : { 'aria-checked': String(item.checked) }),
      },
      el('span', { class: 'context-menu-item-label' }, item.label),
      ...(item.detail === undefined
        ? []
        : [el('span', { class: 'context-menu-item-detail' }, item.detail)]),
      ...(item.toggle === true && item.checked !== undefined
        ? [
            el(
              'span',
              {
                class: item.checked ? 'context-menu-switch is-on' : 'context-menu-switch',
                'aria-hidden': 'true',
              },
              el('i'),
            ),
          ]
        : item.checked === true
          ? [checkIcon('ui-icon ui-icon-sm context-menu-item-check')]
          : []),
    )
    if (item.checked === true) btn.classList.add('is-checked')
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
    const target = e.target instanceof Node ? e.target : null
    if (menu.contains(target)) return
    outsidePress = { target, at: Date.now() }
    dismiss()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // The menu is the topmost interaction, including when it lives inside a
    // native dialog. Consume Escape so dismissing the menu does not also run
    // the dialog's native cancel action (or a workspace shortcut behind it).
    e.preventDefault()
    e.stopPropagation()
    dismiss()
  }

  const dialog = withinDialog?.closest('dialog')
  ;(dialog ?? document.body).append(menu)
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
