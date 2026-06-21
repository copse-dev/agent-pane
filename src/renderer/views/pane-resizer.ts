import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, type LayoutState } from '@shared/types/layout.ts'

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function clampNumber(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback
  return clamp(val, min, max)
}

export function parseSavedLayout(raw: unknown): LayoutState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAYOUT }
  const saved = raw as Record<string, unknown>
  return {
    projectsPaneWidth: clampNumber(
      saved.projectsPaneWidth,
      DEFAULT_LAYOUT.projectsPaneWidth,
      LAYOUT_LIMITS.projects.min,
      LAYOUT_LIMITS.projects.max,
    ),
    filesPaneWidth: clampNumber(
      saved.filesPaneWidth,
      DEFAULT_LAYOUT.filesPaneWidth,
      LAYOUT_LIMITS.files.min,
      4000,
    ),
    fileTreeWidth: clampNumber(
      saved.fileTreeWidth,
      DEFAULT_LAYOUT.fileTreeWidth,
      LAYOUT_LIMITS.tree.min,
      LAYOUT_LIMITS.tree.max,
    ),
  }
}

export function applyLayout(body: HTMLElement, layout: LayoutState): void {
  body.style.setProperty('--projects-width', `${layout.projectsPaneWidth}px`)
  body.style.setProperty('--files-width', `${layout.filesPaneWidth}px`)
  body.style.setProperty('--tree-width', `${layout.fileTreeWidth}px`)
}

function maxFilesWidth(body: HTMLElement): number {
  return Math.floor(body.clientWidth * LAYOUT_LIMITS.files.maxRatio)
}

function mountResizeHandle(
  handle: HTMLElement,
  opts: {
    startWidth: () => number
    deltaToWidth: (startWidth: number, deltaX: number) => number
    applyWidth: (width: number) => void
    min: number
    max: () => number
    onCommit: () => void
  },
): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('is-dragging')

    const startX = e.clientX
    const initial = opts.startWidth()

    const onMove = (ev: PointerEvent) => {
      const width = clamp(opts.deltaToWidth(initial, ev.clientX - startX), opts.min, opts.max())
      opts.applyWidth(width)
    }

    const onUp = () => {
      handle.classList.remove('is-dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      opts.onCommit()
    }

    document.body.style.cursor = 'col-resize'
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

  const commitLayout = () => {
    const layout = store.getState().layout
    const rounded: LayoutState = {
      projectsPaneWidth: Math.round(layout.projectsPaneWidth),
      filesPaneWidth: Math.round(layout.filesPaneWidth),
      fileTreeWidth: Math.round(layout.fileTreeWidth),
    }
    store.setState({ layout: rounded })
    applyLayout(body, rounded)
    void api.settings.set('layout', rounded)
  }

  const setLayout = (partial: Partial<LayoutState>) => {
    const layout = { ...store.getState().layout, ...partial }
    store.setState({ layout })
    applyLayout(body, layout)
  }

  mountResizeHandle(projectsResizer, {
    startWidth: () => store.getState().layout.projectsPaneWidth,
    deltaToWidth: (start, delta) => start + delta,
    applyWidth: (width) => setLayout({ projectsPaneWidth: width }),
    min: LAYOUT_LIMITS.projects.min,
    max: () => LAYOUT_LIMITS.projects.max,
    onCommit: commitLayout,
  })

  mountResizeHandle(filesResizer, {
    startWidth: () => store.getState().layout.filesPaneWidth,
    deltaToWidth: (start, delta) => start - delta,
    applyWidth: (width) => setLayout({ filesPaneWidth: width }),
    min: LAYOUT_LIMITS.files.min,
    max: () => maxFilesWidth(body),
    onCommit: commitLayout,
  })

  mountResizeHandle(treeResizer, {
    startWidth: () => store.getState().layout.fileTreeWidth,
    deltaToWidth: (start, delta) => start + delta,
    applyWidth: (width) => setLayout({ fileTreeWidth: width }),
    min: LAYOUT_LIMITS.tree.min,
    max: () => LAYOUT_LIMITS.tree.max,
    onCommit: commitLayout,
  })

  const syncFilesResizer = () => {
    filesResizer.hidden = !store.getState().filesPaneOpen
  }

  syncFilesResizer()
  const unsub = store.on('files_pane_changed', syncFilesResizer)

  return () => unsub()
}
