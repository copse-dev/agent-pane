import type { ApiClient } from '../../preload/api.d.ts'
import { artefactUrl } from '@shared/canvas/artefact.ts'
import {
  BROWSER_SESSION_PARTITION,
  browserSessionPartition,
  browserThreadScope,
} from '@shared/browser-session.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import { el } from '../dom/helpers.ts'
import { maximizeIcon, penLineIcon, spinnerIcon } from '../dom/icons.ts'
import { mountAnnotationLayer, type AnnotationLayer } from '../drawing/annotation-layer.ts'
import { attachAnnotation } from '../drawing/attach-annotation.ts'
import { trackGuestScroll, type GuestScrollTracker } from '../drawing/scroll-tracker.ts'
import {
  getArtefactContent,
  getArtefactPreview,
  loadArtefactContent,
  requestArtefactShow,
} from './artefact-previews.ts'

const WEBVIEW_PREFS = 'contextIsolation=true'
const LOAD_TIMEOUT_MS = 30_000
const inlineArtefactDisposers = new WeakMap<HTMLElement, () => void>()

/** Release lazy annotation listeners before transcript reconciliation removes a card. */
export function disposeInlineArtefacts(root: ParentNode): void {
  const cards = new Set<HTMLElement>()
  if (root instanceof HTMLElement && root.classList.contains('canvas-inline-artefact')) {
    cards.add(root)
  }
  root.querySelectorAll<HTMLElement>('.canvas-inline-artefact').forEach((card) => {
    cards.add(card)
  })
  for (const card of cards) {
    inlineArtefactDisposers.get(card)?.()
    inlineArtefactDisposers.delete(card)
  }
}

function supportsElectronWebview(element: HTMLElement): boolean {
  return typeof Reflect.get(element, 'getURL') === 'function'
}

function syncWebviewSize(stage: HTMLElement, webview: HTMLElement): void {
  const { width, height } = stage.getBoundingClientRect()
  if (width <= 0 || height <= 0) return
  webview.style.width = `${String(Math.round(width))}px`
  webview.style.height = `${String(Math.round(height))}px`
}

/**
 * Create a process-isolated Electron guest for an interactive artefact. The
 * Browser pane uses the same partition and URL derivation; this is merely a
 * smaller host surface with no navigation chrome.
 */
function createInlineWebview(
  stage: HTMLElement,
  artefact: CanvasArtefact,
  projectId: string,
  threadId: string,
  onReady: () => void,
  onFailure: () => void,
): HTMLElement | null {
  if (artefact.mimeType !== 'text/html') return null

  const webview = document.createElement('webview')
  if (!supportsElectronWebview(webview)) return null

  webview.className = 'canvas-inline-webview'
  webview.setAttribute(
    'partition',
    browserSessionPartition(BROWSER_SESSION_PARTITION, browserThreadScope(projectId, threadId)),
  )
  webview.setAttribute('webpreferences', WEBVIEW_PREFS)
  webview.setAttribute('allowpopups', 'false')
  webview.setAttribute('aria-label', `Interactive prototype: ${artefact.title}`)

  let loadingArtefact = false
  let settled = false
  let wasConnected = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let observer: ResizeObserver | null = null
  const syncSize = (): void => {
    if (webview.isConnected && stage.isConnected) {
      wasConnected = true
      syncWebviewSize(stage, webview)
      return
    }
    if (wasConnected) {
      observer?.disconnect()
      observer = null
    }
  }
  const finish = (ready: boolean): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (ready) onReady()
    else onFailure()
  }

  webview.addEventListener('dom-ready', () => {
    // Reconciliation can replace a transcript card while its initial blank
    // guest is still becoming ready. Do not navigate that detached guest:
    // Electron otherwise rejects its stale guest id asynchronously.
    if (!webview.isConnected || !stage.isConnected) {
      if (timer) clearTimeout(timer)
      timer = null
      observer?.disconnect()
      observer = null
      settled = true
      return
    }
    // The transcript is commonly assembled in a detached fragment. ResizeObserver
    // can report that zero-sized state before the card mounts, so every guest
    // lifecycle boundary also re-pins the explicit Electron viewport.
    syncSize()
    if (!loadingArtefact) {
      loadingArtefact = true
      timer = setTimeout(() => {
        finish(false)
      }, LOAD_TIMEOUT_MS)
      webview.setAttribute('src', artefactUrl(artefact))
      return
    }
    finish(true)
  })
  webview.addEventListener('did-fail-load', () => {
    if (loadingArtefact) finish(false)
  })

  observer = new ResizeObserver(syncSize)
  observer.observe(stage)
  webview.addEventListener('destroyed', () => {
    if (timer) clearTimeout(timer)
    timer = null
    settled = true
    observer?.disconnect()
    observer = null
  })

  // The guest's partition must be fixed before attachment. Start at a harmless
  // document, then navigate once Electron reports that the guest is ready.
  webview.setAttribute('src', 'about:blank')
  requestAnimationFrame(syncSize)
  return webview
}

function canvasStage(title: string, preview: string | undefined): HTMLElement {
  const children: Node[] = []
  if (preview) {
    children.push(
      el('img', {
        class: 'canvas-preview-image',
        src: preview,
        alt: `Preview of ${title}`,
      }),
    )
  } else {
    children.push(
      el(
        'div',
        { class: 'canvas-inline-placeholder' },
        spinnerIcon('ui-icon canvas-inline-placeholder-icon'),
        el('span', {}, 'Preparing interactive preview…'),
      ),
    )
  }
  return el('div', { class: 'canvas-inline-stage' }, ...children)
}

/** Build the assistant-facing inline canvas surface for one presentation reference. */
export function createInlineArtefact(
  api: ApiClient,
  projectId: string,
  threadId: string,
  title: string,
): HTMLElement {
  const preview = getArtefactPreview(threadId, title)
  const stage = canvasStage(title, preview)
  const status = el(
    'span',
    { class: 'canvas-inline-status', 'aria-live': 'polite' },
    'Loading preview',
  )
  const open = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost canvas-preview-open',
      'aria-label': `Open ${title} in canvas`,
    },
    maximizeIcon('ui-icon ui-icon-sm'),
    'Open canvas',
  )
  open.addEventListener('click', () => {
    requestArtefactShow(threadId, title)
  })

  const annotate = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost canvas-preview-annotate',
      'aria-label': `Annotate ${title}`,
      'aria-pressed': 'false',
    },
    penLineIcon('ui-icon ui-icon-sm'),
    'Annotate',
  )
  let annotation: AnnotationLayer | null = null
  let annotationScroll: GuestScrollTracker | null = null
  let inlineWebview: HTMLElement | null = null
  let disposed = false
  let firstMountFrame: number | null = null
  let stableMountFrame: number | null = null
  /** The guest's webContents id, when the card is showing a live interactive guest. */
  const inlineWebContentsId = (): number | null => {
    const getId: unknown = inlineWebview
      ? Reflect.get(inlineWebview, 'getWebContentsId')
      : undefined
    if (typeof getId !== 'function' || card.dataset['canvasState'] !== 'interactive') return null
    const contentsId: unknown = Reflect.apply(getId, inlineWebview, [])
    return typeof contentsId === 'number' ? contentsId : null
  }
  // A live guest is captured through the same IPC as a Browser pane tab; a
  // card still on its snapshot falls back to that snapshot.
  const captureBase = async (): Promise<string | null> => {
    const contentsId = inlineWebContentsId()
    if (contentsId !== null) {
      return (await api.browser.captureScreenshot(contentsId)).dataUrl
    }
    return getArtefactPreview(threadId, title) ?? null
  }
  /** Poll the guest only while there are marks to keep anchored or the layer is in use. */
  const syncAnnotationScroll = (): void => {
    annotationScroll?.setEnabled(
      annotation !== null && (annotation.active || !annotation.isEmpty()),
    )
  }
  annotate.addEventListener('click', () => {
    if (!annotation) {
      annotation = mountAnnotationLayer(stage, {
        label: title,
        captureBase,
        onSend: (payload): boolean => {
          return attachAnnotation(payload, title)
        },
        onDeactivate: (): void => {
          annotate.setAttribute('aria-pressed', 'false')
          syncAnnotationScroll()
        },
      })
      // Page-anchored marks track the artefact's own scrolling too.
      const layer = annotation
      annotationScroll = trackGuestScroll({
        wheelTarget: stage,
        fetchPosition: async () => {
          const contentsId = inlineWebContentsId()
          if (contentsId === null) return null
          return await api.browser.scrollPosition(contentsId)
        },
        onScroll: (position) => {
          layer.setScrollOffset(position.x, position.y)
        },
      })
    }
    annotate.setAttribute('aria-pressed', String(annotation.toggle()))
    // Enabling reads the guest's current offsets straight away, so the first
    // stroke on an already-scrolled artefact lands where the page is now.
    syncAnnotationScroll()
    annotationScroll?.kick()
  })

  const card = el(
    'figure',
    {
      class: 'canvas-preview-card canvas-inline-artefact',
      'data-canvas-state': 'loading',
    },
    stage,
    el(
      'figcaption',
      { class: 'canvas-preview-footer' },
      el(
        'span',
        { class: 'canvas-preview-heading' },
        el('span', { class: 'canvas-preview-title' }, title),
        status,
      ),
      el('span', { class: 'canvas-preview-actions' }, open, annotate),
    ),
  )
  inlineArtefactDisposers.set(card, () => {
    disposed = true
    if (firstMountFrame !== null) cancelAnimationFrame(firstMountFrame)
    if (stableMountFrame !== null) cancelAnimationFrame(stableMountFrame)
    annotationScroll?.dispose()
    annotationScroll = null
    annotation?.dispose()
    annotation = null
  })

  const showFallback = (): void => {
    card.dataset['canvasState'] = preview ? 'snapshot' : 'unavailable'
    status.textContent = preview ? 'Preview' : 'Open in canvas to view'
    stage.querySelector('.canvas-inline-webview')?.remove()
    const placeholder = stage.querySelector('.canvas-inline-placeholder')
    if (placeholder) placeholder.textContent = 'Preview unavailable'
  }

  const mount = (artefact: CanvasArtefact | null): void => {
    if (disposed || !artefact || !card.isConnected) {
      if (card.isConnected) showFallback()
      return
    }
    const webview = createInlineWebview(
      stage,
      artefact,
      projectId,
      threadId,
      () => {
        if (disposed) return
        card.dataset['canvasState'] = 'interactive'
        status.textContent = 'Interactive'
      },
      () => {
        if (!disposed) showFallback()
      },
    )
    if (!webview) {
      showFallback()
      return
    }
    inlineWebview = webview
    stage.append(webview)
  }

  const scheduleMount = (artefact: CanvasArtefact | null): void => {
    // Hydration replaces the initial transcript in the next frame. Wait until
    // this card has remained connected across two frames before creating an
    // Electron guest; removing a guest while Chromium is still attaching it
    // rejects asynchronously with Invalid guestInstanceId.
    firstMountFrame = requestAnimationFrame(() => {
      firstMountFrame = null
      if (disposed || !card.isConnected) return
      stableMountFrame = requestAnimationFrame(() => {
        stableMountFrame = null
        mount(artefact)
      })
    })
  }

  const cached = getArtefactContent(projectId, threadId, title)
  if (cached) {
    scheduleMount(cached)
  } else {
    void loadArtefactContent(api, projectId, threadId, title).then(scheduleMount)
  }

  return card
}
