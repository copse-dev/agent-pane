import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { browserTabLabel, normalizeBrowserUrl } from '@shared/browser-url.ts'
import { BROWSER_SESSION_PARTITION } from '@shared/browser-session.ts'

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

const WEBVIEW_PREFS = 'contextIsolation=true'

function browserModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'browser'
}

function createWebview(): BrowserWebviewElement {
  const webview = document.createElement('webview') as BrowserWebviewElement
  webview.setAttribute('partition', BROWSER_SESSION_PARTITION)
  webview.setAttribute('webpreferences', WEBVIEW_PREFS)
  webview.setAttribute('allowpopups', 'false')
  webview.className = 'browser-webview'
  // Attach the guest immediately; navigation waits for dom-ready.
  webview.src = 'about:blank'
  return webview
}

export function mountBrowserPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
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
  listHeader.append(newBtn)

  const tabsWrap = el('div', { class: 'browser-tabs-list' })
  listRoot.append(listHeader, tabsWrap)

  const body = el('div', { class: 'browser-body' })
  viewerRoot.append(body)

  const tabs = new Map<string, BrowserTab>()
  let activeTabId: string | null = null
  let resizeObserver: ResizeObserver | null = null

  function updateNavButtons(tab: BrowserTab) {
    const webview = tab.webview
    if (!webview || !tab.webviewReady) {
      tab.backBtn.disabled = true
      tab.forwardBtn.disabled = true
      return
    }
    tab.backBtn.disabled = !webview.canGoBack()
    tab.forwardBtn.disabled = !webview.canGoForward()
  }

  function syncTabLabel(tab: BrowserTab) {
    const url = webviewUrl(tab) || tab.pendingUrl || 'about:blank'
    const title = webviewTitle(tab)
    tab.label = browserTabLabel(url, title)
    tab.tabLabelEl.textContent = tab.label
  }

  function displayUrl(tab: BrowserTab): string {
    if (tab.pendingUrl) return tab.pendingUrl
    const loaded = webviewUrl(tab)
    return loaded === 'about:blank' ? '' : loaded
  }

  function syncAddressBar(tab: BrowserTab) {
    const url = displayUrl(tab)
    if (document.activeElement !== tab.urlInput) {
      tab.urlInput.value = url
    }
    updateNavButtons(tab)
    syncTabLabel(tab)
  }

  function syncWebviewSize(tab: BrowserTab) {
    const webview = tab.webview
    if (!webview || !tab.panel.classList.contains('is-active')) return
    const { width, height } = tab.webviewHost.getBoundingClientRect()
    if (width <= 0 || height <= 0) return
    webview.style.width = `${Math.round(width)}px`
    webview.style.height = `${Math.round(height)}px`
  }

  function whenWebviewReady(tab: BrowserTab, fn: () => void) {
    const webview = tab.webview
    if (!webview) return
    if (tab.webviewReady) {
      fn()
      return
    }
    webview.addEventListener(
      'dom-ready',
      () => {
        tab.webviewReady = true
        fn()
      },
      { once: true },
    )
  }

  function navigateWebview(tab: BrowserTab, url: string) {
    tab.loadError = null
    tab.urlInput.classList.remove('has-error')
    whenWebviewReady(tab, () => {
      const webview = tab.webview!
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

    const onNavigate = () => {
      if (activeTabId === tab.id) syncAddressBar(tab)
    }

    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', onNavigate)
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
    webview.addEventListener('new-window', (event: Event) => {
      const detail = event as Event & { url?: string }
      if (detail.url) addTab({ url: detail.url, activate: true })
    })

    return webview
  }

  function navigateTab(tab: BrowserTab, rawUrl: string) {
    const url = normalizeBrowserUrl(rawUrl)
    tab.pendingUrl = url === 'about:blank' ? null : url
    tab.urlInput.value = url === 'about:blank' ? '' : url
    if (browserModeActive(store)) {
      ensureWebview(tab)
      navigateWebview(tab, url)
    }
    syncTabLabel(tab)
  }

  function wireToolbar(tab: BrowserTab) {
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
    const submitUrl = () => navigateTab(tab, tab.urlInput.value)
    tab.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitUrl()
      }
    })
  }

  function setActiveTab(tabId: string) {
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

  function openRequestedBrowserUrl(rawUrl: string) {
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
    ) as HTMLButtonElement

    const backBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn',
        'aria-label': 'Back',
        title: 'Back',
        disabled: true,
      },
      '←',
    ) as HTMLButtonElement
    const forwardBtn = el(
      'button',
      {
        type: 'button',
        class: 'browser-nav-btn',
        'aria-label': 'Forward',
        title: 'Forward',
        disabled: true,
      },
      '→',
    ) as HTMLButtonElement
    const reloadBtn = el(
      'button',
      { type: 'button', class: 'browser-nav-btn', 'aria-label': 'Reload', title: 'Reload' },
      '↻',
    ) as HTMLButtonElement
    const urlInput = el('input', {
      type: 'text',
      class: 'browser-url-input',
      placeholder: 'Enter URL or search',
      spellcheck: 'false',
    }) as HTMLInputElement
    const goBtn = el(
      'button',
      { type: 'button', class: 'browser-go-btn', 'aria-label': 'Go', title: 'Go' },
      'Go',
    )

    const toolbar = el(
      'div',
      { class: 'browser-toolbar' },
      backBtn,
      forwardBtn,
      reloadBtn,
      urlInput,
      goBtn,
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
    }

    goBtn.addEventListener('click', () => navigateTab(tab, tab.urlInput.value))
    wireToolbar(tab)

    tabBtn.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.browser-tabs-tab-close')) return
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

  function removeTab(tabId: string) {
    const tab = tabs.get(tabId)
    if (!tab) return
    tab.webview?.remove()
    tab.tabBtn.remove()
    tab.panel.remove()
    tabs.delete(tabId)

    if (activeTabId !== tabId) return
    const remaining = [...tabs.keys()]
    if (remaining.length > 0) {
      setActiveTab(remaining[remaining.length - 1]!)
    } else {
      activeTabId = null
      if (browserModeActive(store)) addTab()
    }
  }

  function onBrowserModeChange() {
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
        if (!resizeObserver) {
          resizeObserver = new ResizeObserver(() => {
            const current = activeTabId ? tabs.get(activeTabId) : null
            if (current) syncWebviewSize(current)
          })
        }
        resizeObserver.observe(tab.webviewHost)
      }
    } else if (resizeObserver) {
      resizeObserver.disconnect()
    }
  }

  newBtn.addEventListener('click', () => addTab())

  onBrowserModeChange()

  const unsubs = [
    store.on('right_panel_mode_changed', onBrowserModeChange),
    store.on('files_pane_changed', onBrowserModeChange),
    store.on('browser_url_requested', openRequestedBrowserUrl),
  ]

  return () => {
    unsubs.forEach((u) => u())
    resizeObserver?.disconnect()
    for (const tab of tabs.values()) {
      tab.webview?.remove()
      tab.tabBtn.remove()
      tab.panel.remove()
    }
    tabs.clear()
  }
}
