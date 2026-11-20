/**
 * Annotation overlay: an SVG drawing surface laid over a host element (the
 * Browser pane's webview host, an inline canvas card's stage) with a floating
 * tool strip. "Send to agent" flattens the marks onto a capture of whatever
 * sits underneath and hands the caller both the SVG (exact geometry, small
 * enough to give a text model) and a PNG (what a vision model sees).
 *
 * Marks are anchored to the *page*, not the viewport: the host relays the
 * guest's scroll position through `setScrollOffset()` and the SVG shifts its
 * `viewBox` to match, so a mark drawn on a heading moves with that heading as
 * the user scrolls. Drawing coordinates stay page-relative either way — the
 * viewBox maps the pointer's client position onto page space for drauu, and
 * exports bake the same offset in so the flattened image lines up with the
 * captured viewport.
 *
 * The tool strip is one row. Its hosts run from a full-window image viewer to
 * a narrow side pane, so it measures itself against the host and gives things
 * up in a fixed order (see `STRIP_LAYOUTS`) rather than wrapping over the page
 * being annotated. Ink colour lives behind one button for the same reason.
 *
 * Nothing is mounted until the first `activate()`, so hosts that never
 * annotate pay nothing. Once marks exist the layer stays visible after
 * "Done" but stops taking pointer events, so the page underneath is usable
 * again while the marks remain until cleared. Sending keeps them too: a mark
 * the user went to the trouble of drawing usually describes the next message
 * as well, and clearing is one click away.
 */
import { el } from '../dom/helpers.ts'
import {
  arrowUpRightIcon,
  chevronDownIcon,
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
/** The tools that fold behind one button when the strip runs out of room. */
const SHAPE_TOOLS: readonly AnnotationTool[] = ['line', 'arrow', 'rect', 'ellipse']

function isShape(tool: AnnotationTool): boolean {
  return SHAPE_TOOLS.includes(tool)
}

const TOOL_LABELS: Record<AnnotationTool, string> = {
  pen: 'Pen',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  eraser: 'Eraser',
}

function toolIcon(tool: AnnotationTool): SVGSVGElement {
  const icon = {
    pen: penLineIcon,
    line: slashIcon,
    arrow: arrowUpRightIcon,
    rect: squareIcon,
    ellipse: circleIcon,
    eraser: eraserIcon,
  }[tool]
  return icon('ui-icon ui-icon-sm')
}

interface StripLayout {
  /** Whether the primary action shows its full label or the compact one. */
  send: 'long' | 'short'
  /** Whether each shape has its own button or all four share one. */
  shapes: 'each' | 'folded'
  /** Tight drops the separators and narrows the buttons to the 24px target minimum. */
  spacing: 'regular' | 'tight'
}

/**
 * What the strip gives up as its host narrows, widest first. The first layout
 * that fits on one row wins; the last is used when nothing does.
 */
const STRIP_LAYOUTS: readonly StripLayout[] = [
  { send: 'long', shapes: 'each', spacing: 'regular' },
  { send: 'short', shapes: 'each', spacing: 'regular' },
  { send: 'short', shapes: 'folded', spacing: 'regular' },
  { send: 'short', shapes: 'folded', spacing: 'tight' },
]

const DEFAULT_ACTION_LABEL = 'Send to agent'
/** The default label once the strip is tight. A caller's own label is never shortened. */
const COMPACT_ACTION_LABEL = 'Send'

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
  /**
   * The user pressed Send. Return false to keep the marks in place when the
   * caller could not attach them, or true to consume the annotation.
   */
  onSend: (payload: AnnotationExport) => boolean | Promise<boolean>
  /** Label for the primary annotation action; defaults to Send to agent. */
  actionLabel?: string
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
  /**
   * Anchor the marks to the page: `x`/`y` are the guest's scroll offsets in
   * CSS pixels. Hosts call this on guest scroll, navigation, and resize; the
   * layer shifts its viewBox so marks move with the content they were drawn
   * on. Hosts that never call it get viewport-anchored marks (offset 0,0).
   */
  setScrollOffset(x: number, y: number): void
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
  let strip: HTMLElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let svg: SVGSVGElement | null = null
  let drauu: Drauu | null = null
  let active = false
  let tool: AnnotationTool = 'pen'
  /** The shape the fold button stands for: the last one used. */
  let shape: AnnotationTool = 'arrow'
  let colour = ANNOTATION_COLOURS[0]?.value ?? '#e5484d'
  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>()
  let foldBtn: HTMLButtonElement | null = null
  let inkBtn: HTMLButtonElement | null = null
  /** The open ink or shape menu and the button it hangs from; one at a time. */
  let popover: { node: HTMLElement; anchor: HTMLButtonElement } | null = null
  const sendLabel = options.actionLabel ?? DEFAULT_ACTION_LABEL
  const compactSendLabel = options.actionLabel ?? COMPACT_ACTION_LABEL
  let sendBtn: HTMLButtonElement | null = null
  let undoBtn: HTMLButtonElement | null = null
  let clearBtn: HTMLButtonElement | null = null
  let sending = false
  let scrollX = 0
  let scrollY = 0

  const fmt = (v: number): string => String(Math.round(v * 100) / 100)

  /** Shift the drawing surface so page-anchored marks track the guest's scroll. */
  const applyViewBox = (): void => {
    if (!svg) return
    const rect = host.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    svg.setAttribute('viewBox', `${fmt(scrollX)} ${fmt(scrollY)} ${fmt(width)} ${fmt(height)}`)
  }

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
    if (foldBtn) {
      const holdsShape = isShape(tool)
      foldBtn.setAttribute('aria-pressed', String(holdsShape))
      foldBtn.setAttribute('aria-label', TOOL_LABELS[shape])
      // Pressing it again once it is selected opens the other shapes.
      foldBtn.setAttribute('data-tooltip', holdsShape ? 'More shapes' : TOOL_LABELS[shape])
      foldBtn.firstElementChild?.replaceWith(toolIcon(shape))
    }
    if (inkBtn) {
      const name = ANNOTATION_COLOURS.find((entry) => entry.value === colour)?.name
      inkBtn.setAttribute('aria-label', name ? `Ink colour: ${name}` : 'Ink colour')
      inkBtn.style.setProperty('--annotation-swatch', colour)
    }
  }

  const closePopover = (): void => {
    if (!popover) return
    const { node, anchor } = popover
    popover = null
    window.removeEventListener('pointerdown', onOutsidePress, true)
    const heldFocus = node.contains(document.activeElement)
    node.remove()
    anchor.setAttribute('aria-expanded', 'false')
    // A removed node drops focus to <body>; hand it back so the keyboard stays in the strip.
    if (heldFocus) anchor.focus({ preventScroll: true })
  }

  /** A press anywhere else dismisses the menu. Its own button is left to toggle it. */
  const onOutsidePress = (event: PointerEvent): void => {
    if (!popover) return
    const { target } = event
    if (
      target instanceof Node &&
      (popover.node.contains(target) || popover.anchor.contains(target))
    )
      return
    closePopover()
  }

  const selectTool = (next: AnnotationTool): void => {
    tool = next
    if (isShape(next)) shape = next
    closePopover()
    applyBrush()
  }

  const openPopover = (anchor: HTMLButtonElement, kind: 'ink' | 'shapes'): void => {
    if (!root || !strip) return
    closePopover()
    const node = el('div', {
      class: 'annotation-popover',
      role: 'group',
      'aria-label': kind === 'ink' ? 'Ink colour' : 'Shapes',
    })
    if (kind === 'ink') {
      for (const { name, value } of ANNOTATION_COLOURS) {
        const swatch = el('button', {
          type: 'button',
          class: 'annotation-swatch',
          'aria-label': name,
          'data-tooltip': name,
          'aria-pressed': String(value === colour),
        })
        swatch.style.setProperty('--annotation-swatch', value)
        swatch.addEventListener('click', () => {
          colour = value
          closePopover()
          applyBrush()
        })
        node.append(swatch)
      }
    } else {
      for (const name of SHAPE_TOOLS) {
        const button = el(
          'button',
          {
            type: 'button',
            class: 'annotation-tool',
            'data-tool': name,
            'aria-label': TOOL_LABELS[name],
            'data-tooltip': TOOL_LABELS[name],
            'aria-pressed': String(name === tool),
          },
          toolIcon(name),
        )
        button.addEventListener('click', () => {
          selectTool(name)
        })
        node.append(button)
      }
    }
    // As on the strip: a press here must not start a stroke underneath.
    node.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
    })
    root.append(node)
    // Under the strip, centred on its button, and inside the host by the strip's own margin.
    const bounds = root.getBoundingClientRect()
    const edge = strip.getBoundingClientRect()
    const from = anchor.getBoundingClientRect()
    const inset = edge.top - bounds.top
    const width = node.offsetWidth
    const centred = from.left + from.width / 2 - bounds.left - width / 2
    node.style.left = `${fmt(Math.max(inset, Math.min(centred, bounds.width - width - inset)))}px`
    node.style.top = `${fmt(edge.bottom - bounds.top)}px`
    anchor.setAttribute('aria-expanded', 'true')
    popover = { node, anchor }
    window.addEventListener('pointerdown', onOutsidePress, true)
    node.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true })
  }

  const togglePopover = (anchor: HTMLButtonElement, kind: 'ink' | 'shapes'): void => {
    if (popover?.anchor === anchor) closePopover()
    else openPopover(anchor, kind)
  }

  /**
   * Pick the widest layout that fits the host on one row. Measured, not keyed
   * to a breakpoint: the action label, the interface scale and the font all
   * move the strip's width.
   */
  const fitStrip = (): void => {
    if (!strip || !sendBtn || !active) return
    const before = `${strip.dataset['send'] ?? ''}/${strip.dataset['shapes'] ?? ''}`
    for (const layout of STRIP_LAYOUTS) {
      strip.dataset['send'] = layout.send
      strip.dataset['shapes'] = layout.shapes
      strip.dataset['spacing'] = layout.spacing
      sendBtn.textContent = layout.send === 'long' ? sendLabel : compactSendLabel
      if (strip.scrollWidth <= strip.clientWidth) break
    }
    // A menu hanging from a button that just folded away has nothing to point at.
    if (before !== `${strip.dataset['send'] ?? ''}/${strip.dataset['shapes'] ?? ''}`) closePopover()
  }

  /** The button that stands for the current tool in the layout on screen. */
  const currentToolButton = (): HTMLButtonElement | undefined => {
    if (foldBtn && isShape(tool) && strip?.dataset['shapes'] === 'folded') return foldBtn
    return toolButtons.get(tool)
  }

  const isEmpty = (): boolean => !svg || svg.childElementCount === 0

  const syncButtons = (): void => {
    const empty = isEmpty()
    if (sendBtn) sendBtn.disabled = empty || sending
    if (clearBtn) clearBtn.disabled = empty
    if (undoBtn) undoBtn.disabled = !drauu?.canUndo()
    if (root) root.hidden = !active && empty
  }

  const toolButton = (name: AnnotationTool): HTMLButtonElement => {
    const button = el(
      'button',
      {
        type: 'button',
        class: isShape(name) ? 'annotation-tool annotation-shape' : 'annotation-tool',
        'data-tool': name,
        'aria-label': TOOL_LABELS[name],
        'data-tooltip': TOOL_LABELS[name],
        'aria-pressed': 'false',
      },
      toolIcon(name),
    )
    button.addEventListener('click', () => {
      selectTool(name)
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
    applyViewBox()

    const separator = (): HTMLElement =>
      el('span', { class: 'annotation-sep', 'aria-hidden': 'true' })

    // Stands in for the four shape buttons when the strip is tight (see
    // STRIP_LAYOUTS): one press takes the last shape used, a second opens the rest.
    const fold = el(
      'button',
      {
        type: 'button',
        class: 'annotation-tool annotation-shape-fold',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        'aria-pressed': 'false',
      },
      toolIcon(shape),
      chevronDownIcon('ui-icon ui-picker-chevron annotation-fold-caret'),
    )
    fold.addEventListener('click', () => {
      if (isShape(tool)) togglePopover(fold, 'shapes')
      else selectTool(shape)
    })
    foldBtn = fold

    // One dot in the current ink, not a swatch per colour: changing ink is rare
    // next to choosing a tool, and four swatches were a fifth of the strip.
    const ink = el(
      'button',
      {
        type: 'button',
        class: 'annotation-tool annotation-ink',
        'data-tooltip': 'Ink colour',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      },
      el('span', { class: 'annotation-ink-dot' }),
    )
    ink.addEventListener('click', () => {
      togglePopover(ink, 'ink')
    })
    inkBtn = ink

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
      {
        type: 'button',
        class: 'ui-btn ui-btn-primary annotation-send',
        // The name stays whole when the visible label is the compact one.
        'aria-label': sendLabel,
        disabled: true,
      },
      sendLabel,
    )
    sendBtn.addEventListener('click', () => {
      if (sending) return
      sending = true
      sendBtn?.setAttribute('aria-busy', 'true')
      syncButtons()
      void layer
        .export()
        .then(async (payload) => {
          const accepted = await options.onSend(payload)
          if (!accepted) return
          // Sent, not spent: the marks stay where they were drawn so the next
          // message can build on the same annotation. Leave the mode so the
          // page is interactive again; Done/Clear remove marks explicitly.
          layer.deactivate()
        })
        // Callers surface expected attachment failures by returning false. Keep
        // unexpected failures contained too: the marks remain available to retry.
        .catch(() => {})
        .finally(() => {
          sending = false
          sendBtn?.removeAttribute('aria-busy')
          syncButtons()
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

    const toolstrip = el(
      'div',
      { class: 'annotation-toolstrip', role: 'toolbar', 'aria-label': 'Annotation tools' },
      toolButton('pen'),
      ...SHAPE_TOOLS.map(toolButton),
      fold,
      toolButton('eraser'),
      ink,
      separator(),
      undoBtn,
      clearBtn,
      separator(),
      sendBtn,
      doneBtn,
    )
    // Clicks on the strip must not start a stroke underneath it.
    toolstrip.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
    })
    strip = toolstrip

    root = el('div', { class: 'annotation-layer', 'data-active': 'false' }, svg, toolstrip)
    root.hidden = true
    host.append(root)
    // The viewBox carries the host's size as well as the guest's scroll, and a
    // pane resize need not move the scroll at all, so size changes re-apply it
    // directly rather than waiting for a scroll report that may never come.
    // The same size decides how much of the strip fits.
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        applyViewBox()
        fitStrip()
      })
      resizeObserver.observe(host)
    }

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
      // An open menu takes the first Escape; the mode takes the next.
      if (popover) closePopover()
      else layer.deactivate()
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
      // The strip is only measurable once it is on screen.
      fitStrip()
      // A layer over a webview needs to hold focus so Esc/Cmd+Z reach us, not the guest.
      currentToolButton()?.focus({ preventScroll: true })
    },
    deactivate(): void {
      if (!active) return
      active = false
      drauu?.cancel()
      closePopover()
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
      selectTool(next)
    },
    setScrollOffset(x: number, y: number): void {
      // Negative offsets are real (right-to-left pages scroll to negative X);
      // a non-finite one is not, and keeps the axis where it was.
      if (Number.isFinite(x)) scrollX = x
      if (Number.isFinite(y)) scrollY = y
      applyViewBox()
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
      // Marks live in page space; the capture underneath is viewport space.
      // The exported viewBox crops the page to exactly the captured viewport.
      clone.setAttribute(
        'viewBox',
        `${fmt(scrollX)} ${fmt(scrollY)} ${String(width)} ${String(height)}`,
      )
      // outerHTML serialises foreign (SVG) content with explicit end tags, so the
      // result is well-formed XML as well as HTML; no XMLSerializer needed.
      const serialised = clone.outerHTML
      const base = await options.captureBase?.().catch((): null => null)
      let png: string | null = null
      let captured = false
      if (base) {
        png = await composeAnnotationPng(serialised, width, height, base).catch((): null => null)
        captured = png !== null
      }
      // A bad or undecodable surface capture must not lose the annotation. The
      // marks-only raster is still useful and is the fallback promised by the UI.
      png ??= await composeAnnotationPng(serialised, width, height, null).catch((): null => null)
      return {
        svg: serialised,
        png,
        captured,
        width,
        height,
        marks,
      }
    },
    dispose(): void {
      layer.deactivate()
      resizeObserver?.disconnect()
      resizeObserver = null
      drauu?.unmount()
      drauu = null
      root?.remove()
      root = null
      strip = null
      svg = null
    },
  }

  return layer
}
