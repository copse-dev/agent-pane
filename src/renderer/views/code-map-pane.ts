import { el } from '../dom/helpers.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { homeIcon, minusIcon, plusIcon, searchIcon, trunkIcon } from '../dom/icons.ts'
import { cssColorToHex, readEditorThemeTokens } from '../dom/editor-theme.ts'
import type { AppStore } from '@shared/store/store.ts'
import { CODE_MAP_SESSION_PARTITION } from '@shared/code-map-session.ts'
import type { ApiClient } from '../../preload/api.d.ts'

/** Minimal typing for Electron's guest `<webview>` element (see browser-pane.ts). */
interface CodeMapWebviewElement extends HTMLElement {
  src: string
  executeJavaScript?(code: string): Promise<unknown>
}

const WEBVIEW_PREFS = 'contextIsolation=true'

function supportsElectronWebview(element: HTMLElement): boolean {
  return typeof Reflect.get(element, 'loadURL') === 'function'
}

/** JSON-serializable: no raw string interpolation of user content into the script. */
function loadFilesScript(name: string, files: { path: string; content: string }[]): string {
  const payload = JSON.stringify({ name, files })
  return `window.__copseLoadFiles && window.__copseLoadFiles(${payload}.files, ${payload}.name)`
}

/** The chrome colors forwarded to the embedded blockviz panel (its `ChromeColors`). */
interface CodeMapChrome {
  dark: boolean
  background: string
  panel: string
  ink: string
  muted: string
  line: string
  accent: string
}

/**
 * Reads Copse's own live theme tokens and resolves the two the panel needs
 * that `readEditorThemeTokens` doesn't carry (`--text-secondary`,
 * `--accent-color`) through the same hidden-probe trick it uses internally,
 * since both can be a `color-mix()` formula rather than a plain color.
 */
function resolveCodeMapChrome(): CodeMapChrome {
  const tokens = readEditorThemeTokens()
  const root = document.documentElement
  const probe = document.createElement('span')
  probe.hidden = true
  root.append(probe)
  const resolve = (property: string, fallback: string): string => {
    probe.style.color = `var(${property})`
    return cssColorToHex(getComputedStyle(probe).color) ?? fallback
  }
  const muted = resolve('--text-secondary', tokens.foreground)
  const accent = resolve('--accent-color', tokens.scheme === 'dark' ? '#5b9bff' : '#2563eb')
  probe.remove()
  return {
    dark: tokens.scheme === 'dark',
    background: tokens.background,
    panel: tokens.elevated,
    ink: tokens.foreground,
    muted,
    line: tokens.border,
    accent,
  }
}

function pushThemeScript(colors: CodeMapChrome): string {
  const payload = JSON.stringify(colors)
  return `window.__copseSetTheme && window.__copseSetTheme(${payload})`
}

/**
 * Calls `onChange` with freshly resolved chrome whenever Copse's own
 * appearance changes. Mirrors `editor-theme.ts`'s `watchEditorTheme` (same
 * attribute filter, same "the root element is the only reliable signal, not
 * an event" reasoning) but also tracks `--accent-color`, which that module
 * doesn't resolve.
 */
function watchCodeMapChrome(onChange: (colors: CodeMapChrome) => void): () => void {
  let current = resolveCodeMapChrome()
  const observer = new MutationObserver(() => {
    const next = resolveCodeMapChrome()
    if (JSON.stringify(next) === JSON.stringify(current)) return
    current = next
    onChange(next)
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-tint-palette', 'data-tint-strength', 'style'],
  })
  return () => observer.disconnect()
}

export function mountCodeMapPane(
  viewerRoot: HTMLElement,
  store: AppStore,
  api?: ApiClient,
): () => void {
  // No sidebar: blockviz is one unified canvas, not a list to pick an item
  // from, so its header sits full-width atop the viewer instead of in the
  // narrow rail other panes use for a file/connection list (right-panel-layout.ts).
  // blockviz's own floating topbar/toolbar/zoombar are hidden for #embedded=1
  // (vendor/blockviz styles.css) — this header is the only chrome left, so it
  // also carries the handful of their actions worth a visible trigger; each
  // click reaches the guest through a __copse* bridge (app.ts). Keyboard
  // access ('/', h, +/-) keeps working either way. No "fit": home already
  // resets to the same whole-project view.
  function bridgeButton(
    iconEl: SVGSVGElement,
    ariaLabel: string,
    title: string,
    bridgeFn: string,
  ): HTMLButtonElement {
    const btn = el(
      'button',
      { type: 'button', class: 'pane-header-icon-btn', 'aria-label': ariaLabel },
      iconEl,
    )
    btn.title = title
    btn.addEventListener('click', () => {
      void webview?.executeJavaScript?.(`window.${bridgeFn} && window.${bridgeFn}()`)
    })
    return btn
  }
  const header = el(
    'div',
    { class: 'pane-header' },
    el('span', { class: 'pane-header-title' }, 'Code Map'),
    el(
      'span',
      { class: 'pane-header-actions' },
      bridgeButton(minusIcon('ui-icon ui-icon-sm'), 'Zoom out', 'Zoom out (−)', '__copseZoomOut'),
      bridgeButton(plusIcon('ui-icon ui-icon-sm'), 'Zoom in', 'Zoom in (+)', '__copseZoomIn'),
      bridgeButton(
        homeIcon('ui-icon ui-icon-sm'),
        'Whole project',
        'Whole project (H)',
        '__copseHome',
      ),
      bridgeButton(
        trunkIcon('ui-icon ui-icon-sm'),
        'Tidy arrows',
        'Tidy arrows: draw one branching line out of each block, not a separate line for every value',
        '__copseToggleTrunk',
      ),
      bridgeButton(
        searchIcon('ui-icon ui-icon-sm'),
        'Search the code map',
        'Search (/)',
        '__copseOpenSearch',
      ),
      paneMaximizeButton(store, 'code map'),
    ),
  )
  viewerRoot.append(header)

  const body = el('div', { class: 'code-map-body' })
  const status = el('div', { class: 'code-map-status' }, 'Opening Code Map…')
  body.append(status)
  viewerRoot.append(body)

  let webview: CodeMapWebviewElement | null = null
  let loadToken = 0

  function setStatus(message: string | null): void {
    status.textContent = message ?? ''
    status.hidden = message === null
  }

  async function load(): Promise<void> {
    if (!api) {
      setStatus('Code Map is unavailable in this window.')
      return
    }
    const token = ++loadToken
    setStatus('Opening Code Map…')
    let previewUrl: string
    try {
      previewUrl = await api.codeMap.getPreviewUrl()
    } catch (err) {
      if (token !== loadToken) return
      setStatus(err instanceof Error ? err.message : 'Code Map failed to start.')
      return
    }
    if (token !== loadToken) return

    const { activeProjectId, activeThreadId } = store.getState()
    if (!activeProjectId || !activeThreadId) {
      setStatus('Open a project thread to see its Code Map.')
      return
    }

    if (!webview) {
      const guest = document.createElement('webview') as CodeMapWebviewElement
      if (!supportsElectronWebview(guest)) {
        setStatus('Code Map needs the desktop app (not available in this preview).')
        return
      }
      guest.setAttribute('partition', CODE_MAP_SESSION_PARTITION)
      guest.setAttribute('webpreferences', WEBVIEW_PREFS)
      guest.setAttribute('allowpopups', 'false')
      guest.className = 'code-map-webview'
      guest.addEventListener('dom-ready', () => {
        if (token !== loadToken) return
        setStatus(null)
        void guest.executeJavaScript?.(pushThemeScript(resolveCodeMapChrome()))
        void handOffFiles(guest, token, activeProjectId, activeThreadId)
      })
      guest.addEventListener('did-fail-load', () => {
        if (token !== loadToken) return
        setStatus('Code Map failed to load.')
      })
      body.append(guest)
      webview = guest
    }
    webview.src = `${previewUrl}#embedded=1`
  }

  async function handOffFiles(
    guest: CodeMapWebviewElement,
    forToken: number,
    projectId: string,
    threadId: string,
  ): Promise<void> {
    if (!api) return
    let project: { name: string; files: { path: string; content: string }[] }
    try {
      project = await api.codeMap.getFiles(projectId, threadId)
    } catch (err) {
      if (forToken !== loadToken) return
      setStatus(err instanceof Error ? err.message : 'Could not read the project files.')
      return
    }
    if (forToken !== loadToken) return
    await guest.executeJavaScript?.(loadFilesScript(project.name, project.files))
  }

  // Reloads on the thread this panel last showed changing, not on every open/close
  // toggle — switching threads while the panel stays open is a known gap (no
  // dedicated "active thread changed" event wired up yet for this).
  let lastLoadedKey: string | null = null
  function syncVisibility(): void {
    if (store.getState().rightPanelMode !== 'codemap') return
    const { activeProjectId, activeThreadId } = store.getState()
    const key = activeProjectId && activeThreadId ? `${activeProjectId}:${activeThreadId}` : null
    if (key === lastLoadedKey) return
    lastLoadedKey = key
    void load()
  }

  syncVisibility()
  const unsubscribe = store.on('right_panel_mode_changed', syncVisibility)
  const unwatchChrome = watchCodeMapChrome((colors) => {
    void webview?.executeJavaScript?.(pushThemeScript(colors))
  })

  return () => {
    unsubscribe()
    unwatchChrome()
    loadToken++
  }
}
