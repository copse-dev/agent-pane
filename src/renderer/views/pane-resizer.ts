import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, type LayoutState } from '@shared/types/layout.ts'
import { PORTRAIT_RIGHT_PANEL_CLASS } from './portrait-right-panel-layout.ts'
import { isRecord } from '@shared/unknown-value.ts'

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function clampNumber(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback
  return clamp(val, min, max)
}

export function parseSavedLayout(raw: unknown): LayoutState {
  if (!isRecord(raw)) return { ...DEFAULT_LAYOUT }
  const saved = raw
  return {
    projectsPaneWidth: clampNumber(
      saved['projectsPaneWidth'],
      DEFAULT_LAYOUT.projectsPaneWidth,
      LAYOUT_LIMITS.projects.min,
      LAYOUT_LIMITS.projects.max,
    ),
    filesPaneWidth: clampNumber(
      saved['filesPaneWidth'],
      DEFAULT_LAYOUT.filesPaneWidth,
      LAYOUT_LIMITS.files.min,
      4000,
    ),
    filesPaneHeight: clampNumber(
      saved['filesPaneHeight'],
      DEFAULT_LAYOUT.filesPaneHeight,
      LAYOUT_LIMITS.filesStacked.min,
      4000,
    ),
    fileTreeWidth: clampNumber(
      saved['fileTreeWidth'],
      DEFAULT_LAYOUT.fileTreeWidth,
      LAYOUT_LIMITS.tree.min,
      LAYOUT_LIMITS.tree.max,
    ),
  }
}

export function applyLayout(body: HTMLElement, layout: LayoutState): void {
  body.style.setProperty('--projects-width', `${String(layout.projectsPaneWidth)}px`)
  body.style.setProperty('--files-width', `${String(layout.filesPaneWidth)}px`)
  body.style.setProperty('--files-height', `${String(layout.filesPaneHeight)}px`)
  body.style.setProperty('--tree-width', `${String(layout.fileTreeWidth)}px`)
}

function maxFilesWidth(body: HTMLElement, projectsPaneWidth: number): number {
  if (body.clientWidth <= 0) return Number.POSITIVE_INFINITY
  const sharedWidth = Math.max(0, body.clientWidth - projectsPaneWidth)
  return Math.floor(sharedWidth * LAYOUT_LIMITS.files.maxRatio)
}

function maxStackedFilesHeight(body: HTMLElement): number {
  return Math.floor(body.clientHeight * LAYOUT_LIMITS.filesStacked.maxRatio)
}

function mountResizeHandle(
  handle: HTMLElement,
  opts: {
    startSize: () => number
    deltaToSize: (startSize: number, deltaX: number, deltaY: number) => number
    applySize: (size: number) => void
    min: () => number
    max: () => number
    cursor: () => string
    onCommit: () => void
  },
): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('is-dragging')

    const startX = e.clientX
    const startY = e.clientY
    const initial = opts.startSize()
    const cursor = opts.cursor()

    const onMove = (ev: PointerEvent): void => {
      const size = clamp(
        opts.deltaToSize(initial, ev.clientX - startX, ev.clientY - startY),
        opts.min(),
        opts.max(),
      )
      opts.applySize(size)
    }

    const onUp = (): void => {
      handle.classList.remove('is-dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      opts.onCommit()
    }

    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  })
}

export function mountPaneResizers(body: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const projectsResizer = document.getElementById('resizer-projects')
  const filesResizer = document.getElementById('resizer-files')
  const treeResizer = document.getElementById('resizer-tree')
  if (!projectsResizer || !filesResizer || !treeResizer) return () => {}

  applyLayout(body, store.getState().layout)

  const commitLayout = (): void => {
    const layout = store.getState().layout
    const rounded: LayoutState = {
      projectsPaneWidth: Math.round(layout.projectsPaneWidth),
      filesPaneWidth: Math.round(layout.filesPaneWidth),
      filesPaneHeight: Math.round(layout.filesPaneHeight),
      fileTreeWidth: Math.round(layout.fileTreeWidth),
    }
    store.setState({ layout: rounded })
    applyLayout(body, rounded)
    void api.settings.set('layout', rounded)
  }

  const setLayout = (partial: Partial<LayoutState>): void => {
    const layout = { ...store.getState().layout, ...partial }
    store.setState({ layout })
    applyLayout(body, layout)
  }

  const filesPanelStacked = (): boolean => body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS)
  const fitSidePanelToChat = (): void => {
    const state = store.getState()
    if (!state.filesPaneOpen || filesPanelStacked()) return
    const maxWidth = maxFilesWidth(body, state.layout.projectsPaneWidth)
    if (state.layout.filesPaneWidth <= maxWidth) return
    setLayout({ filesPaneWidth: maxWidth })
  }

  // A saved width may have been valid in a larger window. Reconcile it before
  // the next paint whenever the available side-by-side space changes.
  fitSidePanelToChat()

  mountResizeHandle(projectsResizer, {
    startSize: () => store.getState().layout.projectsPaneWidth,
    deltaToSize: (start, deltaX) => start + deltaX,
    applySize: (width) => {
      setLayout({ projectsPaneWidth: width })
      fitSidePanelToChat()
    },
    min: () => LAYOUT_LIMITS.projects.min,
    max: () => LAYOUT_LIMITS.projects.max,
    cursor: () => 'col-resize',
    onCommit: commitLayout,
  })

  mountResizeHandle(filesResizer, {
    startSize: () =>
      filesPanelStacked()
        ? store.getState().layout.filesPaneHeight
        : store.getState().layout.filesPaneWidth,
    deltaToSize: (start, deltaX, deltaY) => start + (filesPanelStacked() ? -deltaY : -deltaX),
    applySize: (size) => {
      setLayout(filesPanelStacked() ? { filesPaneHeight: size } : { filesPaneWidth: size })
    },
    min: () => (filesPanelStacked() ? LAYOUT_LIMITS.filesStacked.min : LAYOUT_LIMITS.files.min),
    max: () =>
      filesPanelStacked()
        ? maxStackedFilesHeight(body)
        : maxFilesWidth(body, store.getState().layout.projectsPaneWidth),
    cursor: () => (filesPanelStacked() ? 'row-resize' : 'col-resize'),
    onCommit: commitLayout,
  })

  mountResizeHandle(treeResizer, {
    startSize: () => store.getState().layout.fileTreeWidth,
    deltaToSize: (start, deltaX) => start + deltaX,
    applySize: (width) => {
      setLayout({ fileTreeWidth: width })
    },
    min: () => LAYOUT_LIMITS.tree.min,
    max: () => LAYOUT_LIMITS.tree.max,
    cursor: () => 'col-resize',
    onCommit: commitLayout,
  })

  const syncFilesResizer = (): void => {
    filesResizer.hidden = !store.getState().filesPaneOpen
    fitSidePanelToChat()
  }

  syncFilesResizer()
  const unsub = store.on('files_pane_changed', syncFilesResizer)
  window.addEventListener('resize', fitSidePanelToChat, { passive: true })

  return () => {
    unsub()
    window.removeEventListener('resize', fitSidePanelToChat)
  }
}
