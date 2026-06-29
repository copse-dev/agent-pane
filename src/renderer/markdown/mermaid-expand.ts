import { el } from '../dom/helpers.ts'

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const ZOOM_STEP = 1.15

let expandDialog: HTMLDialogElement | null = null
let viewportEl: HTMLDivElement | null = null
let stageEl: HTMLDivElement | null = null
let zoomLabelEl: HTMLSpanElement | null = null

let scale = 1
let translateX = 0
let translateY = 0

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function applyTransform(): void {
  if (!stageEl) return
  stageEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`
  if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(scale * 100)}%`
}

function resetTransform(): void {
  scale = 1
  translateX = 0
  translateY = 0
  applyTransform()
}

/** Scale and center the diagram so it fits inside the expand viewport. */
function fitToViewport(): void {
  if (!viewportEl || !stageEl) return

  scale = 1
  translateX = 0
  translateY = 0
  stageEl.style.transform = 'none'

  const vw = viewportEl.clientWidth
  const vh = viewportEl.clientHeight
  const contentW = stageEl.offsetWidth
  const contentH = stageEl.offsetHeight
  if (contentW <= 0 || contentH <= 0 || vw <= 0 || vh <= 0) {
    stageEl.style.transform = ''
    applyTransform()
    return
  }

  const inset = 8
  const fitScale = Math.min((vw - inset * 2) / contentW, (vh - inset * 2) / contentH)
  scale = clamp(fitScale, MIN_SCALE, MAX_SCALE)
  translateX = (vw - contentW * scale) / 2
  translateY = (vh - contentH * scale) / 2
  stageEl.style.transform = ''
  applyTransform()
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  if (!viewportEl) return
  const rect = viewportEl.getBoundingClientRect()
  const mx = clientX - rect.left
  const my = clientY - rect.top
  const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
  const contentX = (mx - translateX) / scale
  const contentY = (my - translateY) / scale
  scale = nextScale
  translateX = mx - contentX * scale
  translateY = my - contentY * scale
  applyTransform()
}

function bindViewportInteractions(viewport: HTMLDivElement): void {
  let panning = false
  let panStartX = 0
  let panStartY = 0
  let panOriginX = 0
  let panOriginY = 0

  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      zoomAt(event.clientX, event.clientY, factor)
    },
    { passive: false },
  )

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    panning = true
    panStartX = event.clientX
    panStartY = event.clientY
    panOriginX = translateX
    panOriginY = translateY
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('is-panning')
  })

  viewport.addEventListener('pointermove', (event) => {
    if (!panning) return
    translateX = panOriginX + (event.clientX - panStartX)
    translateY = panOriginY + (event.clientY - panStartY)
    applyTransform()
  })

  const endPan = (event: PointerEvent) => {
    if (!panning) return
    panning = false
    viewport.classList.remove('is-panning')
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
  }
  viewport.addEventListener('pointerup', endPan)
  viewport.addEventListener('pointercancel', endPan)
}

function ensureExpandDialog(): HTMLDialogElement {
  if (expandDialog) return expandDialog

  expandDialog = document.createElement('dialog')
  expandDialog.className = 'mermaid-expand-dialog'
  expandDialog.setAttribute('aria-label', 'Diagram preview')

  const body = el('div', { class: 'mermaid-expand-dialog-body' })
  viewportEl = el('div', {
    class: 'mermaid-expand-viewport',
    'aria-label': 'Diagram canvas — scroll to zoom, drag to pan',
  })
  stageEl = el('div', { class: 'mermaid-expand-stage' })
  viewportEl.append(stageEl)
  body.append(viewportEl)
  bindViewportInteractions(viewportEl)

  const toolbar = el('div', { class: 'mermaid-expand-toolbar' })
  const zoomOutBtn = el(
    'button',
    { type: 'button', class: 'mermaid-expand-tool', 'aria-label': 'Zoom out' },
    '−',
  )
  zoomLabelEl = el('span', { class: 'mermaid-expand-zoom-label' }, '100%')
  const zoomInBtn = el(
    'button',
    { type: 'button', class: 'mermaid-expand-tool', 'aria-label': 'Zoom in' },
    '+',
  )
  const resetBtn = el(
    'button',
    { type: 'button', class: 'mermaid-expand-tool', 'aria-label': 'Fit diagram to panel' },
    'Reset',
  )
  const hint = el('span', { class: 'mermaid-expand-hint' }, 'Scroll to zoom · drag to pan')
  toolbar.append(zoomOutBtn, zoomLabelEl, zoomInBtn, resetBtn, hint)

  zoomOutBtn.addEventListener('click', () => {
    if (!viewportEl) return
    const rect = viewportEl.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / ZOOM_STEP)
  })
  zoomInBtn.addEventListener('click', () => {
    if (!viewportEl) return
    const rect = viewportEl.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, ZOOM_STEP)
  })
  resetBtn.addEventListener('click', () => fitToViewport())

  const closeBtn = el('button', { type: 'button', class: 'mermaid-expand-close' }, 'Close')

  expandDialog.append(body, toolbar, closeBtn)
  document.body.append(expandDialog)

  closeBtn.addEventListener('click', () => expandDialog?.close())
  expandDialog.addEventListener('click', (event) => {
    if (event.target === expandDialog) expandDialog?.close()
  })
  expandDialog.addEventListener('close', () => resetTransform())

  return expandDialog
}

function openMermaidExpand(source: HTMLElement): void {
  const svg = source.querySelector('svg')
  if (!svg) return

  const dialog = ensureExpandDialog()
  stageEl!.replaceChildren(svg.cloneNode(true))
  dialog.showModal()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => fitToViewport())
  })
}

/** Fold in-thread diagrams and wire click-to-expand (lightbox dialog). */
export function attachMermaidExpand(root: ParentNode): void {
  const diagrams = root.querySelectorAll<HTMLElement>('.mermaid-diagram')
  for (const diagram of diagrams) {
    if (diagram.dataset['mermaidUi'] === 'true') continue
    if (diagram.querySelector('.error-icon')) continue
    if (!diagram.querySelector('svg')) continue

    diagram.dataset['mermaidUi'] = 'true'
    diagram.classList.remove('mermaid-diagram--pending')
    diagram.classList.add('mermaid-diagram--folded')
    diagram.setAttribute('role', 'button')
    diagram.setAttribute('tabindex', '0')
    diagram.setAttribute('aria-label', 'Expand diagram')

    diagram.addEventListener('click', () => openMermaidExpand(diagram))
    diagram.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openMermaidExpand(diagram)
    })
  }
}
