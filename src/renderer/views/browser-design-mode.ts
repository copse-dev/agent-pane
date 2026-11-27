/**
 * Browser-pane design mode: a toolbar toggle that turns the page into an
 * element picker, and a tray under the page where picked elements wait with a
 * note each until the user sends them to the thread together.
 *
 * While the mode is on, one pick is always armed in the guest (main process,
 * `services/browser/design-mode.ts`); each click resolves it, pins the element
 * and re-arms. A new document ends the old pick, so the next `dom-ready`
 * re-arms. Elements picked on an earlier document stay in the tray (their
 * markup and crop are already captured) but lose their on-page marker.
 */
import { el } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showErrorToast, showToast } from './toast.ts'
import {
  formatDesignNotes,
  formatDesignSource,
  type DesignNoteItem,
  type DesignPickResult,
  type DesignPickedElement,
  type DesignTheme,
} from '@shared/browser-design-mode.ts'
import { setTooltip } from '../dom/tooltip.ts'

const FALLBACK_THEME: DesignTheme = { accent: '#ff93d0', onAccent: '#1b1d1f' }

/**
 * Resolve a CSS colour expression to `rgb(r, g, b)` by painting it. Computed
 * styles can serialise tokens built with `color-mix()` as `color(srgb …)`,
 * which the guest-side schema does not accept.
 */
function paintedRgb(colour: string): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!colour || !context) return null
  context.fillStyle = colour
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`
}

/** The app accent as the tray's badges paint it, for the outlines drawn in the page. */
function resolveTheme(probe: HTMLElement): DesignTheme {
  if (!probe.isConnected) return FALLBACK_THEME
  const style = getComputedStyle(probe)
  const accent = paintedRgb(style.backgroundColor)
  const onAccent = paintedRgb(style.color)
  return accent && onAccent ? { accent, onAccent } : FALLBACK_THEME
}

export interface BrowserDesignApi {
  designPick: (webContentsId: number, theme: DesignTheme) => Promise<DesignPickResult>
  designCancel: (webContentsId: number) => Promise<void>
  designMarkers: (webContentsId: number, pickIds: number[], theme: DesignTheme) => Promise<void>
}

export interface BrowserDesignModeOptions {
  /** The toolbar toggle; its `aria-pressed` mirrors the mode. */
  button: HTMLButtonElement
  /** The guest to pick from, or null while no page is loaded. */
  contentsId: () => number | null
  api: BrowserDesignApi | null
}

export interface BrowserDesignMode {
  /** Mount below the page; hidden while the mode is off and the tray is empty. */
  readonly tray: HTMLElement
  isActive(): boolean
  /** Turn picking on or off; returns the new state. */
  toggle(): boolean
  stop(): void
  /** A new document committed: old markers are gone and so is the armed pick. */
  onNavigated(): void
  /** The guest can run script again: re-arm and redraw markers. */
  onDocumentReady(): void
  dispose(): void
}

interface TrayItem extends DesignNoteItem {
  key: number
  /** Which document the element was picked on; markers only exist on the current one. */
  documentGeneration: number
  row: HTMLElement
  badge: HTMLElement
}

function sizeLabel(element: DesignPickedElement): string {
  return `${String(Math.round(element.rect.width))}×${String(Math.round(element.rect.height))}`
}

export function createBrowserDesignMode(options: BrowserDesignModeOptions): BrowserDesignMode {
  const { button, api } = options
  let active = false
  /** Bumped on every arm and stop, so a stale pick result is dropped. */
  let pickGeneration = 0
  let documentGeneration = 0
  let nextKey = 1
  let items: TrayItem[] = []

  const hint = el(
    'p',
    { class: 'browser-design-hint' },
    'Click an element to pin it. ↑ picks its parent, Esc stops.',
  )
  const clearBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact browser-design-clear' },
    'Clear',
  )
  const sendLabel = el('span', {}, 'Send to agent')
  const sendBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary ui-btn-compact browser-design-send' },
    sendLabel,
  )
  const header = el(
    'div',
    { class: 'browser-design-header' },
    el('span', { class: 'browser-design-title' }, 'Design mode'),
    el('span', { class: 'browser-design-spacer' }),
    clearBtn,
    sendBtn,
  )
  const list = el('ol', { class: 'browser-design-list', 'aria-label': 'Pinned elements' })
  const tray = el(
    'section',
    { class: 'browser-design-tray', 'aria-label': 'Design mode', hidden: '' },
    header,
    hint,
    list,
  )
  // Never shown: carries the badge colours so the page outlines can match them.
  const themeProbe = el('span', { class: 'browser-design-badge browser-design-theme-probe' })
  tray.append(themeProbe)

  function syncChrome(): void {
    button.setAttribute('aria-pressed', String(active))
    const label = active ? 'Stop picking elements' : 'Design mode: pick elements for the agent'
    button.setAttribute('aria-label', label)
    button.setAttribute('data-tooltip', label)
    tray.toggleAttribute('hidden', !active && items.length === 0)
    tray.classList.toggle('is-picking', active)
    hint.textContent = active
      ? items.length === 0
        ? 'Click an element to pin it. ↑ picks its parent, Esc stops.'
        : 'Click another element, or add a note to each one.'
      : 'Picking is off. Turn it back on from the toolbar.'
    const count = items.length
    sendLabel.textContent = count === 0 ? 'Send to agent' : `Send ${String(count)} to agent`
    sendBtn.disabled = count === 0
    clearBtn.disabled = count === 0
    list.toggleAttribute('hidden', count === 0)
    items.forEach((item, index) => {
      item.badge.textContent = String(index + 1)
    })
  }

  function syncMarkers(): void {
    const id = options.contentsId()
    if (id === null || !api) return
    const pickIds = items
      .filter((item) => item.documentGeneration === documentGeneration)
      .map((item) => item.element.pickId)
    void api.designMarkers(id, pickIds, resolveTheme(themeProbe)).catch(() => undefined)
  }

  function removeItem(key: number): void {
    const item = items.find((candidate) => candidate.key === key)
    if (!item) return
    item.row.remove()
    items = items.filter((candidate) => candidate.key !== key)
    syncChrome()
    syncMarkers()
  }

  function addItem(element: DesignPickedElement): void {
    const key = nextKey++
    const badge = el('span', { class: 'browser-design-badge', 'aria-hidden': 'true' })
    const thumb = element.screenshot
      ? el('img', { class: 'browser-design-thumb', src: element.screenshot, alt: '' })
      : el('span', { class: 'browser-design-thumb is-empty' }, element.tag)
    const selector = el(
      'code',
      { class: 'browser-design-selector' },
      element.selector || element.tag,
    )
    const source = el(
      'span',
      { class: element.source ? 'browser-design-source' : 'browser-design-source is-missing' },
      element.source ? formatDesignSource(element.source) : 'No source location from this page',
    )
    if (element.source) {
      const component = element.source.component ? ` (${element.source.component})` : ''
      setTooltip(source, `${formatDesignSource(element.source)}${component}`)
    }
    const meta = el(
      'div',
      { class: 'browser-design-meta' },
      selector,
      el(
        'span',
        { class: 'browser-design-facts' },
        el('span', { class: 'browser-design-size' }, sizeLabel(element)),
        source,
      ),
    )
    const removeBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn browser-design-remove',
        'aria-label': 'Remove pinned element',
        'data-tooltip': 'Remove',
      },
      closeIcon('ui-icon ui-icon-sm'),
    )
    const note = el('textarea', {
      class: 'browser-design-note',
      rows: '1',
      placeholder: 'What should change here?',
      'aria-label': `Note for ${element.selector || element.tag}`,
    })
    const row = el(
      'li',
      { class: 'browser-design-item' },
      el('div', { class: 'browser-design-item-head' }, badge, thumb, meta, removeBtn),
      note,
    )
    const item: TrayItem = { key, element, note: '', documentGeneration, row, badge }
    note.addEventListener('input', () => {
      item.note = note.value
    })
    removeBtn.addEventListener('click', () => {
      removeItem(key)
    })
    items.push(item)
    list.append(row)
    syncChrome()
    syncMarkers()
    note.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest' })
  }

  function arm(): void {
    if (!active) return
    const id = options.contentsId()
    if (id === null || !api) return
    const generation = ++pickGeneration
    api.designPick(id, resolveTheme(themeProbe)).then(
      (result) => {
        if (generation !== pickGeneration || !active) return
        if (result.kind === 'picked') {
          addItem(result.element)
          arm()
        } else if (result.kind === 'cancelled') {
          stop()
        }
        // `navigated`: the next dom-ready re-arms on the new document.
      },
      (error: unknown) => {
        if (generation !== pickGeneration) return
        stop()
        showErrorToast('Could not pick an element on this page', error)
      },
    )
  }

  function start(): boolean {
    if (!api) {
      showToast('Design mode needs the desktop browser.', { variant: 'error' })
      return false
    }
    if (options.contentsId() === null) {
      showToast('Load a page before picking elements.', { variant: 'error' })
      return false
    }
    active = true
    syncChrome()
    arm()
    return true
  }

  function stop(): void {
    if (!active) return
    active = false
    pickGeneration++
    const id = options.contentsId()
    if (id !== null && api) void api.designCancel(id).catch(() => undefined)
    syncChrome()
  }

  function clearItems(): void {
    for (const item of items) item.row.remove()
    items = []
    syncChrome()
    syncMarkers()
  }

  function send(): void {
    if (items.length === 0) return
    const handlers = getPromptAttachmentHandlers()
    if (!handlers) {
      showToast('Open a thread before sending design notes.', { variant: 'error' })
      return
    }
    const batch: DesignNoteItem[] = items.map((item) => ({
      element: item.element,
      note: item.note,
    }))
    const count = batch.length
    handlers.attachTextBlock(
      formatDesignNotes(batch),
      count === 1 ? 'Design note: 1 element' : `Design notes: ${String(count)} elements`,
    )
    for (const item of batch) {
      if (item.element.screenshot) handlers.attachImage(item.element.screenshot, 'image/png')
    }
    stop()
    clearItems()
    handlers.focusComposer?.()
    showToast(
      count === 1
        ? 'Added 1 design note to the thread.'
        : `Added ${String(count)} design notes to the thread.`,
      { durationMs: 2_500 },
    )
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && active) {
      event.preventDefault()
      stop()
    }
  }
  tray.addEventListener('keydown', onKeydown)
  clearBtn.addEventListener('click', clearItems)
  sendBtn.addEventListener('click', send)
  syncChrome()

  return {
    tray,
    isActive: () => active,
    toggle: (): boolean => {
      if (active) {
        stop()
        return false
      }
      return start()
    },
    stop,
    onNavigated: (): void => {
      documentGeneration++
      // The old document's armed pick died with it.
      pickGeneration++
    },
    onDocumentReady: (): void => {
      arm()
      syncMarkers()
    },
    dispose: (): void => {
      stop()
      tray.removeEventListener('keydown', onKeydown)
      tray.remove()
    },
  }
}
