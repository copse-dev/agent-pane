import { el } from '../dom/helpers.ts'
import { cx } from './cx.ts'

export interface UiPaneTabsShellOptions {
  title: string
  headerClassName?: string
  listClassName?: string
  bodyClassName?: string
}

export interface UiPaneTabsShell {
  listHeader: HTMLElement
  titleEl: HTMLElement
  tabsWrap: HTMLElement
  body: HTMLElement
}

/**
 * Builds the header/list/body elements shared by every right-panel tabs pane
 * (Browser, Terminals): a `.pane-header` with a title, a tab-button list, and
 * a content body. Callers mount these themselves — list panes differ in
 * whether the header/list sit directly under `listRoot` or inside a
 * pane-specific wrapper (e.g. the Terminals rail section).
 */
export function uiPaneTabsShell(opts: UiPaneTabsShellOptions): UiPaneTabsShell {
  const titleEl = el('span', { class: 'pane-header-title' }, opts.title)
  const listHeader = el(
    'div',
    { class: cx('pane-header ui-pane-tabs-header', opts.headerClassName) },
    titleEl,
  )
  const tabsWrap = el('div', { class: cx('ui-pane-tabs-list', opts.listClassName) })
  const body = el('div', { class: cx('ui-pane-tabs-body', opts.bodyClassName) })
  return { listHeader, titleEl, tabsWrap, body }
}

export interface UiPaneTabOptions {
  /** The tab button already built by the caller (label, badges, etc). */
  tabBtn: HTMLElement
  /** The content panel already built by the caller. */
  panel: HTMLElement
  /** Selector (within `tabBtn`) for the close affordance; its clicks never select. */
  closeSelector: string
  onSelect: () => void
  onClose: () => void
}

export interface UiPaneTab {
  /** Toggle the shared `is-active` class on both the button and the panel. */
  setActive: (active: boolean) => void
  /** Remove the button and panel from the DOM. */
  remove: () => void
}

/**
 * Wires the click/active/removal behaviour shared by every pane's tab button +
 * content panel pair. Markup stays with the caller (badges, rename-in-place,
 * context menus) — this only owns what Browser and Terminals tabs already did
 * identically: select-unless-close, close-stops-propagation, and the
 * `is-active` toggle mirrored onto both nodes.
 */
export function uiPaneTab(opts: UiPaneTabOptions): UiPaneTab {
  opts.tabBtn.classList.add('ui-pane-tab')
  opts.panel.classList.add('ui-pane-tab-panel')

  opts.tabBtn.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest(opts.closeSelector)) return
    opts.onSelect()
  })
  opts.tabBtn.querySelector(opts.closeSelector)?.addEventListener('click', (e) => {
    e.stopPropagation()
    opts.onClose()
  })

  return {
    setActive: (active: boolean): void => {
      opts.tabBtn.classList.toggle('is-active', active)
      opts.panel.classList.toggle('is-active', active)
    },
    remove: (): void => {
      opts.tabBtn.remove()
      opts.panel.remove()
    },
  }
}
