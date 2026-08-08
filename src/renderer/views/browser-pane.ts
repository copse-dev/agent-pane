import { el } from '../dom/helpers.ts'
import {
  arrowLeftIcon,
  arrowRightIcon,
  externalLinkIcon,
  fileTextIcon,
  imageIcon,
  moreHorizontalIcon,
  refreshIcon,
  searchIcon,
} from '../dom/icons.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { registerPopoutSeedHandlers } from '../popout/pane-popout-seed.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { browserTabLabel, normalizeBrowserUrl } from '@shared/browser-url.ts'
import { BROWSER_SESSION_PARTITION } from '@shared/browser-session.ts'
import { firstNonEmptyString, nonEmptyStringOr } from '@shared/unknown-value.ts'
import type { PackBrowserTabRequest } from '@shared/types/pack-browser.ts'
import { openRightPanel } from '../controller/panels.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showErrorToast, showToast } from './toast.ts'
import type { BrowserImageShare, BrowserTextShare } from '@shared/types/browser-share.ts'

/** Minimal typing for Electron's guest `<webview>` element. */
interface BrowserWebviewElement extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): void
  getURL(): string
  getTitle(): string
  openDevTools(): void
  getWebContentsId(): number
}

interface BrowserTab {
  id: string
  label: string
  panel: HTMLElement
  webviewHost: HTMLElement
  webview: BrowserWebviewElement | null
  webviewReady: boolean
  tabBtn: HTMLButtonElement
  tabLabelEl: HTMLElement
  urlInput: HTMLInputElement
  backBtn: HTMLButtonElement
  forwardBtn: HTMLButtonElement
  reloadBtn: HTMLButtonElement
  pendingUrl: string | null
  loadError: string | null
  /** When set, this tab renders a sandboxed MCP-UI artefact; the data: URL is
   * hidden from the address bar in favour of this friendly title. */
  artefactTitle: string | null
  /** Collapse this tab's overflow ("…") menu, if open. */
  closeMenu: () => void
}

/** The current page URL when it is a real http(s) address (not about:blank or a
 * data: artefact) — i.e. something the system browser can open. */
function currentHttpUrl(tab: BrowserTab): string | null {
  if (tab.artefactTitle) return null
  const url = firstNonEmptyString(webviewUrl(tab), tab.pendingUrl) ?? ''
  return /^https?:\/\//i.test(url) ? url : null
}

/** Encode an HTML document as a base64 `data:` URL (opaque origin, no network). */
function htmlDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}

function webviewUrl(tab: BrowserTab): string {
  if (!tab.webview || !tab.webviewReady || typeof tab.webview.getURL !== 'function') return ''
  try {
    return tab.webview.getURL()
  } catch {
    return ''
  }
}

function webviewTitle(tab: BrowserTab): string | undefined {
  if (!tab.webview || !tab.webviewReady || typeof tab.webview.getTitle !== 'function')
    return undefined
  try {
    return tab.webview.getTitle()
  } catch {
    return undefined
  }
}

function shareableWebContentsId(tab: BrowserTab): number | null {
  if (!tab.webview || !tab.webviewReady) return null
  const url = webviewUrl(tab)
  if ((!url || url === 'about:blank') && !tab.artefactTitle) return null
  try {
    return tab.webview.getWebContentsId()
  } catch {
    return null
  }
}

const WEBVIEW_PREFS = 'contextIsolation=true'

interface BrowserPopoutSeed {
  tabs: Array<{ url: string; label?: string; artefactTitle?: string | null }>
  activeTabIndex: number
}

function isBrowserPopoutSeed(seed: unknown): seed is BrowserPopoutSeed {
  if (!seed || typeof seed !== 'object') return false
  // `in` narrowing rather than an assertion: no-unsafe-type-assertion (#508)
  // rejects narrowing away from `unknown`, and this is the safer check anyway.
  return 'tabs' in seed && Array.isArray(seed.tabs)
}

function browserModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'browser'
}

/**
 * Electron's `<webview>` is a registered custom element, so its methods are on
 * the instance the moment it is created. Outside Electron — the browser demo —
 * the same tag is an inert `HTMLElement`: no methods, and `dom-ready` never
 * fires, so the pane would mount its whole toolbar around a permanently blank
 * box.
 */
function supportsElectronWebview(element: HTMLElement): boolean {
  return typeof (element as Partial<BrowserWebviewElement>).getURL === 'function'
}

/**
 * An `<iframe>` wearing the guest-webview interface, for hosts without Electron.
 *
 * Only navigation is honest here. An iframe cannot report a cross-origin
 * document's URL or title and exposes no session history, so those answer from
 * what we were last asked to load and the history controls stay disabled —
 * better than a Back button that lies. `getWebContentsId` throws, which is what
 * callers already treat as "this page cannot be shared".
 */
function createIframeWebview(): BrowserWebviewElement {
  const frame = document.createElement('iframe')
  frame.className = 'browser-webview'
  // Same intent as the guest's `contextIsolation`: scripts may run, but the
  // page gets an opaque origin and no reach into the demo that embeds it.
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
  frame.setAttribute('referrerpolicy', 'no-referrer')

  let requested = 'about:blank'
  const navigate = (url: string): void => {
    requested = url
    frame.setAttribute('src', url)
  }
  // `src` has to record what it was handed before delegating: it is the only
  // place the requested URL is ever seen, and `getURL` has no other source.
  Object.defineProperty(frame, 'src', {
    get: (): string => requested,
    set: navigate,
    configurable: true,
  })
  // The pane gates every navigation on `dom-ready`; an iframe says `load`.
  frame.addEventListener('load', () => {
    frame.dispatchEvent(new Event('dom-ready'))
    frame.dispatchEvent(new Event('did-navigate'))
  })
  navigate('about:blank')
  // The initial blank document does not reliably announce itself — Chromium
  // creates it synchronously on insertion and may never fire `load` for it — and
  // the pane holds every navigation until the first `dom-ready`. An iframe is in
  // fact ready as soon as it exists, so say so on the next task, once the caller
  // has attached its listener and put us in the document.
  setTimeout(() => frame.dispatchEvent(new Event('dom-ready')), 0)

  return Object.assign(frame, {
    getURL: (): string => requested,
    getTitle: (): string => '',
    loadURL: navigate,
    // Re-setting `src` to the value it already holds is not guaranteed to
    // renavigate, so blank the frame first and restore on the next task.
    reload: (): void => {
      const url = requested
      frame.setAttribute('src', 'about:blank')
      setTimeout(() => {
        frame.setAttribute('src', url)
      }, 0)
    },
    // Nothing can halt a cross-origin load from out here. Blanking the frame
    // would be worse than doing nothing: it discards the page *and* the URL the
    // address bar is showing.
    stop: (): void => {
      /* no-op */
    },
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => undefined,
    goForward: (): void => undefined,
    openDevTools: (): void => undefined,
    getWebContentsId: (): number => {
      throw new Error('No webContents outside Electron.')
    },
  })
}

function createWebview(): BrowserWebviewElement {
  const webview = document.createElement('webview')
  if (!supportsElectronWebview(webview)) return createIframeWebview()
  const guest = webview as BrowserWebviewElement
  guest.setAttribute('partition', BROWSER_SESSION_PARTITION)
  guest.setAttribute('webpreferences', WEBVIEW_PREFS)
  guest.setAttribute('allowpopups', 'false')
  guest.className = 'browser-webview'
  // Attach the guest immediately; navigation waits for dom-ready.
  guest.src = 'about:blank'
  return guest
}

export function mountBrowserPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api?: ApiClient,
): () => void {
  const listHeader = el('div', { class: 'browser-tabs-list-header' }, 'Tabs')
  const newBtn = el(
    'button',
    {
      type: 'button',
      class: 'browser-tabs-new-btn',
      'aria-label': 'New browser tab',
      title: 'New tab',
    },
    '+',
  )
  if (api) listHeader.append(panePopoutButton(store, api, 'browser', 'browser'))
  listHeader.append(newBtn)

  const tabsWrap = el('div', { class: 'browser-tabs-list' })
  listRoot.append(listHeader, tabsWrap)

  const body = el('div', { class: 'browser-body' })
  viewerRoot.append(body)

  const tabs = new Map<string, BrowserTab>()
  let activeTabId: string | null = null
  let resizeObserver: ResizeObserver | null = null

  function closeAllMenus(): void {
    for (const tab of tabs.values()) tab.closeMenu()
  }

  function attachSharedText(share: BrowserTextShare): void {
    const handlers = getPromptAttachmentHandlers()
    if (!handlers) {
      showToast('Open a thread before sharing browser text.', { variant: 'error' })
      return
    }
    handlers.attachTextBlock(share.content, share.label)
    handlers.focusComposer?.()
    showToast('Added browser text to the thread.', { durationMs: 2_000 })
  }

  function attachSharedImage(share: BrowserImageShare): void {
    const handlers = getPromptAttachmentHandlers()
    if (!handlers) {
      showToast('Open a thread before sharing a browser screenshot.', { variant: 'error' })
      return
    }
    handlers.attachImage(share.dataUrl, share.mimeType)
    handlers.focusComposer?.()
    showToast('Added browser screenshot to the thread.', { durationMs: 2_000 })
  }

  function updateNavButtons(tab: BrowserTab): void {
    const webview = tab.webview
    if (!webview || !tab.webviewReady) {
      tab.backBtn.disabled = true
      tab.forwardBtn.disabled = true
      return
    }
    tab.backBtn.disabled = !webview.canGoBack()
    tab.forwardBtn.disabled = !webview.canGoForward()
  }

  function syncTabLabel(tab: BrowserTab): void {
    if (tab.artefactTitle) {
      tab.label = tab.artefactTitle
      tab.tabLabelEl.textContent = tab.label
      return
    }
    const url = nonEmptyStringOr(
      firstNonEmptyString(webviewUrl(tab), tab.pendingUrl),
      'about:blank',
    )
    const title = webviewTitle(tab)
    tab.label = browserTabLabel(url, title)
    tab.tabLabelEl.textContent = tab.label
  }

  function displayUrl(tab: BrowserTab): string {
    // Don't surface the (large, opaque) artefact data: URL in the address bar.
    if (tab.artefactTitle) return ''
    if (tab.pendingUrl) return tab.pendingUrl
    const loaded = webviewUrl(tab)
    return loaded === 'about:blank' ? '' : loaded
  }

  function syncAddressBar(tab: BrowserTab): void {
    const url = displayUrl(tab)
    // Opening the pane focuses its empty address bar. A host-driven navigation
    // can finish before focus moves, so keep protecting text the user is
    // actively editing while still reflecting a loaded URL in an empty field.
    if (document.activeElement !== tab.urlInput || tab.urlInput.value.length === 0) {
      tab.urlInput.value = url
    }
    updateNavButtons(tab)
    syncTabLabel(tab)
  }

  function syncWebviewSize(tab: BrowserTab): void {
    const webview = tab.webview
    if (!webview || !tab.panel.classList.contains('is-active')) return
    const { width, height } = tab.webviewHost.getBoundingClientRect()
    if (width <= 0 || height <= 0) return
    webview.style.width = `${String(Math.round(width))}px`
    webview.style.height = `${String(Math.round(height))}px`
  }

  function whenWebviewReady(tab: BrowserTab, fn: (webview: BrowserWebviewElement) => void): void {
    const webview = tab.webview
    if (!webview) return
    if (tab.webviewReady) {
      fn(webview)
      return
    }
    webview.addEventListener(
      'dom-ready',
      () => {
        tab.webviewReady = true
        fn(webview)
      },
      { once: true },
    )
  }

  function navigateWebview(tab: BrowserTab, url: string): void {
    tab.loadError = null
    tab.urlInput.classList.remove('has-error')
    whenWebviewReady(tab, (webview) => {
      const current = webview.getURL()
      tab.pendingUrl = null
      if (current === url && url !== 'about:blank') webview.reload()
      else webview.src = url
      syncWebviewSize(tab)
    })
  }

  function ensureWebview(tab: BrowserTab): BrowserWebviewElement {
    if (tab.webview) return tab.webview

    const webview = createWebview()
    tab.webviewHost.append(webview)
    tab.webview = webview

    const onNavigate = (): void => {
      if (activeTabId === tab.id) syncAddressBar(tab)
    }

    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', onNavigate)
    // Guest-page pointer events do not bubble into the embedder document. The
    // webview does receive focus after the overflow button had it, which gives
    // the toolbar a reliable outside-interaction signal.
    webview.addEventListener('focus', closeAllMenus)
    webview.addEventListener('dom-ready', () => {
      tab.webviewReady = true
      syncAddressBar(tab)
      syncWebviewSize(tab)
      if (tab.pendingUrl) {
        const url = tab.pendingUrl
        tab.pendingUrl = null
        navigateWebview(tab, url)
      }
    })
    webview.addEventListener('did-fail-load', (event: Event) => {
      const detail = event as Event & { errorDescription?: string; validatedURL?: string }
      tab.loadError = detail.errorDescription ?? 'Failed to load page'
      tab.urlInput.classList.add('has-error')
      tab.urlInput.title = tab.loadError
    })
    return webview
  }

  function navigateTab(tab: BrowserTab, rawUrl: string): void {
    const url = normalizeBrowserUrl(rawUrl)
    tab.pendingUrl = url === 'about:blank' ? null : url
    tab.urlInput.value = url === 'about:blank' ? '' : url
    if (browserModeActive(store)) {
      ensureWebview(tab)
      navigateWebview(tab, url)
    }
    syncTabLabel(tab)
  }

  function wireToolbar(tab: BrowserTab): void {
    tab.backBtn.addEventListener('click', () => {
      tab.webview?.goBack()
    })
    tab.forwardBtn.addEventListener('click', () => {
      tab.webview?.goForward()
    })
    tab.reloadBtn.addEventListener('click', () => {
      if (tab.webview && tab.webviewReady) tab.webview.reload()
      else navigateTab(tab, tab.urlInput.value)
    })
    const submitUrl = (): void => {
      navigateTab(tab, tab.urlInput.value)
    }
    tab.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitUrl()
      }
    })
  }

  function setActiveTab(tabId: string): void {
    if (activeTabId === tabId) return
    activeTabId = tabId
    for (const tab of tabs.values()) {
      const active = tab.id === tabId
      tab.panel.classList.toggle('is-active', active)
      tab.tabBtn.classList.toggle('is-active', active)
    }
    const tab = tabs.get(tabId)
    if (!tab) return
    if (browserModeActive(store)) {
      ensureWebview(tab)
      if (tab.pendingUrl) {
        const url = tab.pendingUrl
        tab.pendingUrl = null
        navigateWebview(tab, url)
      }
      syncAddressBar(tab)
      requestAnimationFrame(() => {
        syncWebviewSize(tab)
        tab.urlInput.focus()
      })
    }
  }

  function isIdleBrowserTab(tab: BrowserTab): boolean {
    const loaded = webviewUrl(tab)
    return !loaded || loaded === 'about:blank'
  }

  function openRequestedBrowserUrl(rawUrl: string): void {
    const url = normalizeBrowserUrl(rawUrl)
    let tab = activeTabId ? tabs.get(activeTabId) : undefined
    if (!tab || !isIdleBrowserTab(tab)) {
      addTab({ activate: true })
      tab = activeTabId ? tabs.get(activeTabId) : undefined
    }
    if (!tab) return
    setActiveTab(tab.id)
    navigateTab(tab, url)
  }

  /**
   * Cmd/Ctrl+L — focus the active tab's address bar and select what's in it, so
   * the next keystroke replaces the URL. Opens a tab when the pane is empty,
   * matching a browser's "there is always an address bar to type into".
   */
  function focusUrlBar(): void {
    let tab = activeTabId ? tabs.get(activeTabId) : undefined
    if (!tab) {
      addTab({ activate: true })
      tab = activeTabId ? tabs.get(activeTabId) : undefined
    }
    if (!tab) return
    const { urlInput } = tab
    // The pane may have only just been revealed by the menu handler; the panel is
    // still display:none this frame and focus() on a hidden input is a no-op.
    requestAnimationFrame(() => {
      urlInput.focus()
      urlInput.select()
    })
  }

  function openArtefact(artefact: CanvasArtefact): void {
    // text/html renders inline via an opaque data: URL; a URL-list artefact
    // navigates normally (and is still subject to the browser origin policy).
    const isHtml = artefact.mimeType === 'text/html'
    const target = isHtml ? htmlDataUrl(artefact.body) : normalizeBrowserUrl(artefact.body)
    const id = addTab({ activate: true })
    const tab = tabs.get(id)
    if (!tab) return
    tab.artefactTitle = artefact.title
    tab.urlInput.value = ''
    tab.urlInput.placeholder = artefact.title
    syncTabLabel(tab)
    if (browserModeActive(store)) {
      ensureWebview(tab)
      navigateWebview(tab, target)
    } else {
      tab.pendingUrl = target
    }
  }

  function addTab(options?: { url?: string; activate?: boolean }): string {
    const id = crypto.randomUUID()
    const label = browserTabLabel(options?.url ? normalizeBrowserUrl(options.url) : 'about:blank')

    const tabLabelEl = el('span', { class: 'browser-tabs-tab-label' }, label)
    const closeBtn = el(
      'span',
      {
        class: 'browser-tabs-tab-close',
        role: 'button',
        'aria-label': 'Close tab',
        title: 'Close',
      },
      '×',
    )
    const tabBtn = el(
      'button',
      { type: 'button', class: 'browser-tabs-tab', 'data-tab-id': id },
      tabLabelEl,
      closeBtn,
    )

    const backBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn',
        'aria-label': 'Back',
        title: 'Back',
        disabled: true,
      },
      arrowLeftIcon('ui-icon ui-icon-sm'),
    )
    const forwardBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn',
        'aria-label': 'Forward',
        title: 'Forward',
        disabled: true,
      },
      arrowRightIcon('ui-icon ui-icon-sm'),
    )
    const reloadBtn = el(
      'button',
      { type: 'button', class: 'browser-nav-btn', 'aria-label': 'Reload', title: 'Reload' },
      refreshIcon('ui-icon ui-icon-sm'),
    )
    const urlInput = el('input', {
      type: 'text',
      class: 'browser-url-input',
      placeholder: 'Enter URL or search',
      spellcheck: 'false',
    })
    const goBtn = el(
      'button',
      { type: 'button', class: 'browser-go-btn', 'aria-label': 'Go', title: 'Go' },
      'Go',
    )

    const menuBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn browser-menu-btn',
        'aria-label': 'More actions',
        title: 'More actions',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
      moreHorizontalIcon('ui-icon ui-icon-sm'),
    )
    const shareTextItem = el(
      'button',
      { type: 'button', class: 'browser-menu-item', role: 'menuitem' },
      fileTextIcon('ui-icon ui-icon-sm'),
      el('span', {}, 'Share page text'),
    )
    const shareScreenshotItem = el(
      'button',
      { type: 'button', class: 'browser-menu-item', role: 'menuitem' },
      imageIcon('ui-icon ui-icon-sm'),
      el('span', {}, 'Share screenshot'),
    )
    const openExternalItem = el(
      'button',
      { type: 'button', class: 'browser-menu-item', role: 'menuitem' },
      externalLinkIcon('ui-icon ui-icon-sm'),
      el('span', {}, 'Open in default browser'),
    )
    const inspectorItem = el(
      'button',
      { type: 'button', class: 'browser-menu-item', role: 'menuitem' },
      searchIcon('ui-icon ui-icon-sm'),
      el('span', {}, 'Open inspector'),
    )
    const menu = el(
      'div',
      { class: 'browser-menu', role: 'menu', hidden: '' },
      shareTextItem,
      shareScreenshotItem,
      el('div', { class: 'browser-menu-separator', role: 'separator' }),
      openExternalItem,
      inspectorItem,
    )
    const menuWrap = el('div', { class: 'browser-menu-wrap' }, menuBtn, menu)

    const toolbar = el(
      'div',
      { class: 'browser-toolbar' },
      backBtn,
      forwardBtn,
      reloadBtn,
      urlInput,
      goBtn,
      menuWrap,
    )
    const webviewHost = el('div', { class: 'browser-webview-host' })
    const panel = el('div', { class: 'browser-tab-panel', 'data-tab-id': id }, toolbar, webviewHost)

    const tab: BrowserTab = {
      id,
      label,
      panel,
      webviewHost,
      webview: null,
      webviewReady: false,
      tabBtn,
      tabLabelEl,
      urlInput,
      backBtn,
      forwardBtn,
      reloadBtn,
      pendingUrl: null,
      loadError: null,
      artefactTitle: null,
      closeMenu: () => {
        setMenuOpen(false)
      },
    }

    let menuOpen = false
    function setMenuOpen(next: boolean): void {
      menuOpen = next
      menuBtn.setAttribute('aria-expanded', String(next))
      if (next) {
        const shareableId = shareableWebContentsId(tab)
        shareTextItem.disabled = shareableId === null || !api
        shareScreenshotItem.disabled = shareableId === null || !api
        // "Open in default browser" only makes sense for a real web page.
        openExternalItem.disabled = !currentHttpUrl(tab) || !api?.shell
        inspectorItem.disabled = !tab.webview
        menu.removeAttribute('hidden')
      } else {
        menu.setAttribute('hidden', '')
      }
    }
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const opening = !menuOpen
      closeAllMenus()
      setMenuOpen(opening)
    })
    // Clicks inside the menu shouldn't reach the document dismiss handler.
    menu.addEventListener('click', (e) => {
      e.stopPropagation()
    })
    shareTextItem.addEventListener('click', () => {
      setMenuOpen(false)
      const id = shareableWebContentsId(tab)
      if (id === null || !api) return
      void api.browser.sharePageText(id).catch((error: unknown) => {
        showErrorToast('Could not share browser text', error)
      })
    })
    shareScreenshotItem.addEventListener('click', () => {
      setMenuOpen(false)
      const id = shareableWebContentsId(tab)
      if (id === null || !api) return
      void api.browser.shareScreenshot(id).catch((error: unknown) => {
        showErrorToast('Could not share browser screenshot', error)
      })
    })
    openExternalItem.addEventListener('click', () => {
      setMenuOpen(false)
      const url = currentHttpUrl(tab)
      if (url && api?.shell) void api.shell.openExternal(url).catch(() => undefined)
    })
    inspectorItem.addEventListener('click', () => {
      setMenuOpen(false)
      try {
        tab.webview?.openDevTools()
      } catch {
        /* devtools unavailable (webview not yet attached) */
      }
    })

    goBtn.addEventListener('click', () => {
      navigateTab(tab, tab.urlInput.value)
    })
    wireToolbar(tab)

    tabBtn.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('.browser-tabs-tab-close')) return
      setActiveTab(id)
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      removeTab(id)
    })

    tabs.set(id, tab)
    tabsWrap.append(tabBtn)
    body.append(panel)

    if (options?.activate !== false || !activeTabId) setActiveTab(id)
    if (options?.url) navigateTab(tab, options.url)
    return id
  }

  function removeTab(tabId: string): void {
    const tab = tabs.get(tabId)
    if (!tab) return
    tab.webview?.remove()
    tab.tabBtn.remove()
    tab.panel.remove()
    tabs.delete(tabId)

    if (activeTabId !== tabId) return
    const remaining = [...tabs.keys()]
    const last = remaining[remaining.length - 1]
    if (last !== undefined) {
      setActiveTab(last)
    } else {
      activeTabId = null
      if (browserModeActive(store)) addTab()
    }
  }

  function onBrowserModeChange(): void {
    const active = browserModeActive(store)
    if (active) {
      if (tabs.size === 0) addTab()
      const tab = activeTabId ? tabs.get(activeTabId) : null
      if (tab) {
        ensureWebview(tab)
        if (tab.pendingUrl) {
          const url = tab.pendingUrl
          tab.pendingUrl = null
          navigateWebview(tab, url)
        }
        syncAddressBar(tab)
        requestAnimationFrame(() => {
          syncWebviewSize(tab)
          tab.urlInput.focus()
        })
        resizeObserver ??= new ResizeObserver(() => {
          const current = activeTabId ? tabs.get(activeTabId) : null
          if (current) syncWebviewSize(current)
        })
        resizeObserver.observe(tab.webviewHost)
      }
    } else if (resizeObserver) {
      resizeObserver.disconnect()
    }
  }

  newBtn.addEventListener('click', () => addTab())

  onBrowserModeChange()

  // Dismiss any open overflow menu on an outside click or Escape.
  const onDocumentClick = (): void => {
    closeAllMenus()
  }
  const onDocumentKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeAllMenus()
  }
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)

  function purgeAllTabs(): void {
    for (const tab of tabs.values()) {
      tab.webview?.remove()
      tab.tabBtn.remove()
      tab.panel.remove()
    }
    tabs.clear()
    activeTabId = null
  }

  function captureBrowserSeed(): BrowserPopoutSeed {
    const ordered = [...tabs.values()]
    const activeIndex = activeTabId
      ? Math.max(
          0,
          ordered.findIndex((tab) => tab.id === activeTabId),
        )
      : 0
    return {
      tabs: ordered.map((tab) => ({
        // `.find` + `??` rather than a `||` chain: prefer-nullish-coalescing
        // (#508) rejects `||`, but `??` alone would change behaviour — these
        // fall back on EMPTY strings, not just null/undefined.
        url:
          [tab.urlInput.value, webviewUrl(tab), tab.pendingUrl].find((value) => value) ??
          'about:blank',
        label: tab.label,
        artefactTitle: tab.artefactTitle,
      })),
      activeTabIndex: activeIndex,
    }
  }

  function applyBrowserSeed(raw: unknown): void {
    if (!isBrowserPopoutSeed(raw) || raw.tabs.length === 0) return
    purgeAllTabs()
    const createdIds: string[] = []
    for (const entry of raw.tabs) {
      const id = addTab({ activate: false })
      createdIds.push(id)
      const tab = tabs.get(id)
      if (!tab) continue
      if (entry.artefactTitle) {
        tab.artefactTitle = entry.artefactTitle
        tab.urlInput.placeholder = entry.artefactTitle
      }
      if (entry.url && entry.url !== 'about:blank') {
        tab.pendingUrl = entry.url
        tab.urlInput.value = entry.url
      }
      if (entry.label) {
        tab.label = entry.label
        tab.tabLabelEl.textContent = entry.label
      } else if (entry.url && entry.url !== 'about:blank') {
        tab.label = browserTabLabel(entry.url)
        tab.tabLabelEl.textContent = tab.label
      }
    }
    const index = Math.min(Math.max(raw.activeTabIndex, 0), createdIds.length - 1)
    const target = createdIds[index]
    if (target) setActiveTab(target)
  }

  async function ensurePackBrowserTab(
    request: PackBrowserTabRequest,
  ): Promise<{ tabId: string; webContentsId: number }> {
    const hadTabs = tabs.size > 0
    openRightPanel(store, 'browser')
    const preferred = request.preferredTabId ? tabs.get(request.preferredTabId) : undefined
    const initialBlank = !hadTabs && activeTabId ? tabs.get(activeTabId) : undefined
    const tabId = preferred?.id ?? initialBlank?.id ?? addTab({ activate: true })
    setActiveTab(tabId)
    const tab = tabs.get(tabId)
    if (!tab) throw new Error('Browser tab could not be created.')
    const webview = ensureWebview(tab)
    if (tab.webviewReady) return { tabId, webContentsId: webview.getWebContentsId() }
    return new Promise((resolve) => {
      webview.addEventListener(
        'dom-ready',
        () => {
          resolve({ tabId, webContentsId: webview.getWebContentsId() })
        },
        { once: true },
      )
    })
  }

  const unregisterPopoutSeed = registerPopoutSeedHandlers('browser', {
    capture: captureBrowserSeed,
    apply: applyBrowserSeed,
  })

  const unsubs = [
    store.on('right_panel_mode_changed', onBrowserModeChange),
    store.on('files_pane_changed', onBrowserModeChange),
    store.on('browser_url_requested', openRequestedBrowserUrl),
    store.on('browser_url_bar_focus_requested', focusUrlBar),
    store.on('canvas_artefact_requested', openArtefact),
    // cmd/ctrl click and target=_blank links inside a guide open as a new
    // background tab (main blocks the popup window and forwards the URL here).
    api?.browser.onOpenTab((url) => addTab({ url, activate: false })),
    api?.browser.onShareText(attachSharedText),
    api?.browser.onShareImage(attachSharedImage),
    api?.browser.onPackTabRequest(ensurePackBrowserTab),
    (): void => {
      document.removeEventListener('click', onDocumentClick)
    },
    (): void => {
      document.removeEventListener('keydown', onDocumentKeydown)
    },
  ]

  return () => {
    unregisterPopoutSeed()
    unsubs.forEach((unsubscribe) => {
      if (typeof unsubscribe === 'function') unsubscribe()
    })
    resizeObserver?.disconnect()
    for (const tab of tabs.values()) {
      tab.webview?.remove()
      tab.tabBtn.remove()
      tab.panel.remove()
    }
    tabs.clear()
  }
}
