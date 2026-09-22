/**
 * Annotation overlay: an SVG drawing surface laid over a host element (the
 * Browser pane's webview host, an inline canvas card's stage) with a floating
 * tool strip. "Send to agent" flattens the marks onto a capture of whatever
 * sits underneath and hands the caller both the SVG (exact geometry, small
 * enough to give a text model) and a PNG (what a vision model sees).
 *
 * Nothing is mounted until the first `activate()`, so hosts that never
 * annotate pay nothing. Once marks exist the layer stays visible after
 * "Done" but stops taking pointer events, so the page underneath is usable
 * again while the marks remain until cleared or sent away.
 */
import { el } from '../dom/helpers.ts'
import {
  arrowUpRightIcon,
  circleIcon,
  closeIcon,
  eraserIcon,
  penLineIcon,
  slashIcon,
  squareIcon,
  trashIcon,
  undoIcon,
} from '../dom/icons.ts'
import { createDrauu, type Drauu } from './drauu/index.ts'
import { SVG_NS } from './drauu/utils.ts'

export type AnnotationTool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'eraser'

export interface AnnotationMark {
  tool: AnnotationTool
  colour: string
  /** Bounding box in CSS pixels of the host, origin top-left; null when the DOM cannot measure. */
  box: { x: number; y: number; width: number; height: number } | null
}

export interface AnnotationExport {
  /** Self-contained SVG of the marks alone, sized to the host in CSS pixels. */
  svg: string
  /** PNG data URL: the captured surface with the marks flattened on, or the marks alone. */
  png: string | null
  /** Whether a capture of the surface sits beneath the marks in `png`. */
  captured: boolean
  width: number
  height: number
  /** One entry per committed mark, in drawing order. */
  marks: AnnotationMark[]
}

const TOOLS: readonly AnnotationTool[] = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'eraser']

function measureBox(node: Element): AnnotationMark['box'] {
  const getBBox: unknown = Reflect.get(node, 'getBBox')
  if (typeof getBBox !== 'function') return null
  try {
    const box: unknown = Reflect.apply(getBBox, node, [])
    if (
      box &&
      typeof box === 'object' &&
      'x' in box &&
      'y' in box &&
      'width' in box &&
      'height' in box
    ) {
      const { x, y, width, height } = box
      if ([x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
      }
    }
  } catch {
    // Detached or unrenderable geometry; leave the box unknown.
  }
  return null
}

/** The tool a committed mark was tagged with; unknown tags read as the pen. */
function toolOf(node: Element): AnnotationTool {
  const tagged = node.getAttribute('data-tool')
  return TOOLS.find((t) => t === tagged) ?? 'pen'
}

export interface AnnotationLayerOptions {
  /** What is being annotated, for accessible names ("Annotations over Pricing page"). */
  label: string
  /** The pixels beneath the layer as a PNG data URL; null when the host cannot capture. */
  captureBase?: () => Promise<string | null>
  /** The user pressed Send. */
  onSend: (payload: AnnotationExport) => void | Promise<void>
  /** The user left annotation mode (Done, Escape, or `deactivate()`). */
  onDeactivate?: () => void
}

export interface AnnotationLayer {
  readonly active: boolean
  activate(): void
  deactivate(): void
  /** Flip annotation mode; returns the new state. */
  toggle(): boolean
  isEmpty(): boolean
  clear(): void
  setTool(tool: AnnotationTool): void
  export(): Promise<AnnotationExport>
  dispose(): void
}

/** Ink colours that read on both light and dark pages. */
export const ANNOTATION_COLOURS: readonly { name: string; value: string }[] = [
  { name: 'Red', value: '#e5484d' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Yellow', value: '#eab308' },
]

const SHAPE_SIZE = 3
const PEN_SIZE = 6

/** Flatten `svg` (sized `width`×`height` CSS px) onto `base`, a PNG data URL or null, at device scale. */
export function composeAnnotationPng(
  svg: string,
  width: number,
  height: number,
  base: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const scale = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      reject(new Error('2D canvas unavailable'))
      return
    }
    const loadImage = (src: string): Promise<HTMLImageElement> =>
      new Promise((res, rej) => {
        const img = new Image()
        img.onload = (): void => {
          res(img)
        }
        img.onerror = (): void => {
          rej(new Error('image failed to decode'))
        }
        img.src = src
      })
    const marksUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    void (async (): Promise<void> => {
      try {
        if (base) {
          const baseImage = await loadImage(base)
          ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height)
        }
        const marks = await loadImage(marksUrl)
        ctx.drawImage(marks, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        URL.revokeObjectURL(marksUrl)
      }
    })()
  })
}

export function mountAnnotationLayer(
  host: HTMLElement,
  options: AnnotationLayerOptions,
): AnnotationLayer {
  let root: HTMLElement | null = null
  let svg: SVGSVGElement | null = null
  let drauu: Drauu | null = null
  let active = false
  let tool: AnnotationTool = 'pen'
  let colour = ANNOTATION_COLOURS[0]?.value ?? '#e5484d'
  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>()
  const swatches = new Map<string, HTMLButtonElement>()
  let sendBtn: HTMLButtonElement | null = null
  let undoBtn: HTMLButtonElement | null = null
  let clearBtn: HTMLButtonElement | null = null

  const applyBrush = (): void => {
    if (!drauu) return
    const brush = drauu.brush
    brush.color = colour
    brush.arrowEnd = tool === 'arrow'
    brush.size = tool === 'pen' ? PEN_SIZE : SHAPE_SIZE
    const mode = (
      {
        pen: 'stylus',
        line: 'line',
        arrow: 'line',
        rect: 'rectangle',
        ellipse: 'ellipse',
        eraser: 'eraseLine',
      } as const
    )[tool]
    if (drauu.mode !== mode) drauu.mode = mode
    else if (mode === 'eraseLine') drauu.model.onSelected(drauu.el)
    for (const [name, button] of toolButtons)
      button.setAttribute('aria-pressed', String(name === tool))
    for (const [value, button] of swatches)
      button.setAttribute('aria-pressed', String(value === colour))
  }

  const isEmpty = (): boolean => !svg || svg.childElementCount === 0

  const syncButtons = (): void => {
    const empty = isEmpty()
    if (sendBtn) sendBtn.disabled = empty
    if (clearBtn) clearBtn.disabled = empty
    if (undoBtn) undoBtn.disabled = !drauu?.canUndo()
    if (root) root.hidden = !active && empty
  }

  const toolButton = (
    name: AnnotationTool,
    label: string,
    icon: SVGSVGElement,
  ): HTMLButtonElement => {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'annotation-tool',
        'data-tool': name,
        'aria-label': label,
        'data-tooltip': label,
        'aria-pressed': 'false',
      },
      icon,
    )
    button.addEventListener('click', () => {
      tool = name
      applyBrush()
    })
    toolButtons.set(name, button)
    return button
  }

  const ensureMounted = (): void => {
    if (root) return
    svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'annotation-layer-svg')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', `Annotations over ${options.label}`)

    const separator = (): HTMLElement =>
      el('span', { class: 'annotation-sep', 'aria-hidden': 'true' })

    const swatchButtons = ANNOTATION_COLOURS.map(({ name, value }) => {
      const button = el('button', {
        type: 'button',
        class: 'annotation-swatch',
        'aria-label': name,
        'data-tooltip': name,
        'aria-pressed': 'false',
      })
      button.style.setProperty('--annotation-swatch', value)
      button.addEventListener('click', () => {
        colour = value
        applyBrush()
      })
      swatches.set(value, button)
      return button
    })

    undoBtn = el(
      'button',
      { type: 'button', class: 'annotation-tool', 'aria-label': 'Undo', 'data-tooltip': 'Undo' },
      undoIcon('ui-icon ui-icon-sm'),
    )
    undoBtn.addEventListener('click', () => {
      drauu?.undo()
    })
    clearBtn = el(
      'button',
      { type: 'button', class: 'annotation-tool', 'aria-label': 'Clear', 'data-tooltip': 'Clear' },
      trashIcon('ui-icon ui-icon-sm'),
    )
    clearBtn.addEventListener('click', () => {
      drauu?.clear()
    })
    sendBtn = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-primary annotation-send', disabled: true },
      'Send to agent',
    )
    sendBtn.addEventListener('click', () => {
      sendBtn?.setAttribute('aria-busy', 'true')
      void layer
        .export()
        .then((payload) => options.onSend(payload))
        .finally(() => {
          sendBtn?.removeAttribute('aria-busy')
        })
    })
    const doneBtn = el(
      'button',
      {
        type: 'button',
        class: 'annotation-tool',
        'aria-label': 'Done',
        'data-tooltip': 'Done (Esc)',
      },
      closeIcon('ui-icon ui-icon-sm'),
    )
    doneBtn.addEventListener('click', () => {
      layer.deactivate()
    })

    const strip = el(
      'div',
      { class: 'annotation-toolstrip', role: 'toolbar', 'aria-label': 'Annotation tools' },
      toolButton('pen', 'Pen', penLineIcon('ui-icon ui-icon-sm')),
      toolButton('line', 'Line', slashIcon('ui-icon ui-icon-sm')),
      toolButton('arrow', 'Arrow', arrowUpRightIcon('ui-icon ui-icon-sm')),
      toolButton('rect', 'Rectangle', squareIcon('ui-icon ui-icon-sm')),
      toolButton('ellipse', 'Ellipse', circleIcon('ui-icon ui-icon-sm')),
      toolButton('eraser', 'Eraser', eraserIcon('ui-icon ui-icon-sm')),
      separator(),
      ...swatchButtons,
      separator(),
      undoBtn,
      clearBtn,
      separator(),
      sendBtn,
      doneBtn,
    )
    // Clicks on the strip must not start a stroke underneath it.
    strip.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
    })

    root = el('div', { class: 'annotation-layer', 'data-active': 'false' }, svg, strip)
    root.hidden = true
    host.append(root)

    drauu = createDrauu({
      el: svg,
      brush: { mode: 'stylus', color: colour, size: PEN_SIZE },
    })
    drauu.on('changed', syncButtons)
    // Remember which tool and colour made each mark so the export can describe it.
    drauu.on('committed', (node) => {
      if (!node) return
      node.setAttribute('data-tool', tool)
      node.setAttribute('data-colour', colour)
    })
    applyBrush()
    syncButtons()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      layer.deactivate()
      return
    }
    const meta = event.metaKey || event.ctrlKey
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) drauu?.redo()
      else drauu?.undo()
    }
  }

  const layer: AnnotationLayer = {
    get active(): boolean {
      return active
    },
    activate(): void {
      ensureMounted()
      if (active) return
      active = true
      root?.setAttribute('data-active', 'true')
      window.addEventListener('keydown', onKeyDown)
      syncButtons()
      // A layer over a webview needs to hold focus so Esc/Cmd+Z reach us, not the guest.
      toolButtons.get(tool)?.focus({ preventScroll: true })
    },
    deactivate(): void {
      if (!active) return
      active = false
      drauu?.cancel()
      root?.setAttribute('data-active', 'false')
      window.removeEventListener('keydown', onKeyDown)
      syncButtons()
      options.onDeactivate?.()
    },
    toggle(): boolean {
      if (active) layer.deactivate()
      else layer.activate()
      return active
    },
    isEmpty,
    clear(): void {
      drauu?.clear()
      syncButtons()
    },
    setTool(next: AnnotationTool): void {
      ensureMounted()
      tool = next
      applyBrush()
    },
    async export(): Promise<AnnotationExport> {
      ensureMounted()
      const rect = host.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const marks: AnnotationMark[] = Array.from(svg?.children ?? []).map((node) => {
        return {
          tool: toolOf(node),
          colour: node.getAttribute('data-colour') ?? colour,
          box: measureBox(node),
        }
      })
      const clone = svg ? svg.cloneNode(true) : document.createElementNS(SVG_NS, 'svg')
      if (!(clone instanceof Element)) throw new Error('annotation clone is not an element')
      clone.removeAttribute('class')
      clone.removeAttribute('role')
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(width))
      clone.setAttribute('height', String(height))
      clone.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`)
      // outerHTML serialises foreign (SVG) content with explicit end tags, so the
      // result is well-formed XML as well as HTML; no XMLSerializer needed.
      const serialised = clone.outerHTML
      const base = await options.captureBase?.().catch((): null => null)
      const png = await composeAnnotationPng(serialised, width, height, base ?? null).catch(
        (): null => null,
      )
      return {
        svg: serialised,
        png,
        captured: base !== null && base !== undefined,
        width,
        height,
        marks,
      }
    },
    dispose(): void {
      layer.deactivate()
      drauu?.unmount()
      drauu = null
      root?.remove()
      root = null
      svg = null
    },
  }

  return layer
}
