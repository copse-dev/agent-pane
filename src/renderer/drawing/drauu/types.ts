import type { StrokeOptions } from 'perfect-freehand'

export type DrawingMode = 'draw' | 'stylus' | 'line' | 'rectangle' | 'ellipse' | 'eraseLine'

export interface Brush {
  /** @default 'stylus' */
  mode?: DrawingMode
  /** Stroke colour. */
  color: string
  /** Stroke width. */
  size: number
  /** Fill colour; only `rectangle` and `ellipse` honour it. @default 'transparent' */
  fill?: string
  /** `stroke-dasharray`; leave unset for a solid line. */
  dasharray?: string
  /** Corner radius, `rectangle` mode only. @default 0 */
  cornerRadius?: number
  /** Arrow head at the end of a `draw` or `line` stroke. @default false */
  arrowEnd?: boolean
  /** Options forwarded to perfect-freehand in `stylus` mode. */
  stylusOptions?: StrokeOptions
}

export interface Point {
  x: number
  y: number
  pressure?: number
}

export type PointerInputType = 'mouse' | 'touch' | 'pen'

export interface Options {
  el?: SVGSVGElement
  brush?: Brush
  /** Accept only these pointer types. @default all */
  acceptsInputTypes?: PointerInputType[]
  /** Listen for `pointerdown` on this element instead of the SVG. */
  eventTarget?: Element
  /** Window that receives the move/up/keyboard listeners. @default window */
  window?: Window
  /**
   * Map client coordinates through the SVG's screen CTM (true) or through its
   * bounding rect (false). @default true when the SVG supports it
   */
  coordinateTransform?: boolean
}

export interface EventsMap {
  start: () => void
  end: () => void
  committed: (node: SVGElement | undefined) => void
  canceled: () => void
  changed: () => void
  mounted: () => void
  unmounted: () => void
}

export interface Operation {
  undo: () => void
  redo: () => void
}
