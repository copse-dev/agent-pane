import { Emitter } from './emitter.ts'
import { createModels, type Models } from './models/index.ts'
import type { BaseModel } from './models/base.ts'
import type {
  Brush,
  DrawingMode,
  EventsMap,
  Operation,
  Options,
  PointerInputType,
} from './types.ts'

const DEFAULT_BRUSH: Brush = { color: 'black', size: 3, mode: 'stylus' }

function isPointerInputType(value: string): value is PointerInputType {
  return value === 'mouse' || value === 'touch' || value === 'pen'
}

/**
 * SVG drawing surface. The SVG's children are the model: every committed
 * stroke is a child element, undo removes it and redo puts it back, and
 * `dump()` is the SVG's `innerHTML`.
 */
export class Drauu {
  el: SVGSVGElement | null = null
  svgPoint: DOMPoint | null = null
  shiftPressed = false
  altPressed = false
  drawing = false
  readonly options: Options & { brush: Brush }

  private readonly emitter = new Emitter<EventsMap>()
  private originalPointerId: number | null = null
  private readonly models: Models = createModels(this)
  private currentNode: SVGElement | undefined
  private opStack: Operation[] = []
  private opIndex = 0
  private disposables: (() => void)[] = []
  private elements: (Element | null)[] = []

  constructor(options: Options = {}) {
    this.options = { ...options, brush: options.brush ?? { ...DEFAULT_BRUSH } }
    if (options.el) this.mount(options.el, options.eventTarget, options.window)
  }

  get model(): BaseModel<SVGElement> {
    return this.models[this.mode]
  }

  get mounted(): boolean {
    return this.el !== null
  }

  get mode(): DrawingMode {
    return this.options.brush.mode ?? 'stylus'
  }

  set mode(v: DrawingMode) {
    this.models[this.mode].onUnselected()
    this.options.brush.mode = v
    this.model.onSelected(this.el)
  }

  get brush(): Brush {
    return this.options.brush
  }

  set brush(v: Brush) {
    this.options.brush = v
  }

  mount(el: SVGSVGElement, eventEl?: Element, listenWindow: Window = window): void {
    if (this.el) throw new Error('[drauu] already mounted, unmount previous target first')
    if (el.tagName.toLowerCase() !== 'svg')
      throw new Error('[drauu] can only mount to an SVG element')
    this.el = el
    // jsdom's SVG element has no createSVGPoint; the models then fall back to
    // bounding-rect coordinates (see BaseModel.getMousePosition).
    this.svgPoint = typeof el.createSVGPoint === 'function' ? el.createSVGPoint() : null

    const target: Element = eventEl ?? el
    // The pointerdown target is typed as a bare Element, whose listener map
    // has no pointer events; narrow at runtime instead of asserting.
    const start = (e: Event): void => {
      if (e instanceof PointerEvent) this.eventStart(e)
    }
    const move = (e: PointerEvent): void => {
      this.eventMove(e)
    }
    const end = (e: PointerEvent): void => {
      this.eventEnd(e)
    }
    const keyboard = (e: KeyboardEvent): void => {
      this.eventKeyboard(e)
    }
    const touchMove = (e: TouchEvent): void => {
      this.touchMove(e)
    }

    target.addEventListener('pointerdown', start, { passive: false })
    listenWindow.addEventListener('pointermove', move, { passive: false })
    listenWindow.addEventListener('pointerup', end, { passive: false })
    listenWindow.addEventListener('pointercancel', end, { passive: false })
    listenWindow.addEventListener('keydown', keyboard, false)
    listenWindow.addEventListener('keyup', keyboard, false)
    listenWindow.addEventListener('touchmove', touchMove, { passive: false })

    this.disposables.push(() => {
      target.removeEventListener('pointerdown', start)
      listenWindow.removeEventListener('pointermove', move)
      listenWindow.removeEventListener('pointerup', end)
      listenWindow.removeEventListener('pointercancel', end)
      listenWindow.removeEventListener('keydown', keyboard, false)
      listenWindow.removeEventListener('keyup', keyboard, false)
      listenWindow.removeEventListener('touchmove', touchMove)
    })

    this.model.onSelected(this.el)
    this.emitter.emit('mounted')
  }

  unmount(): void {
    for (const dispose of this.disposables) dispose()
    this.disposables.length = 0
    this.elements.length = 0
    this.el = null
    this.emitter.emit('unmounted')
  }

  on<K extends keyof EventsMap>(type: K, fn: EventsMap[K]): () => void {
    return this.emitter.on(type, fn)
  }

  undo(): boolean {
    if (!this.canUndo() || this.drawing) return false
    this.opIndex -= 1
    this.opStack[this.opIndex]?.undo()
    this.emitter.emit('changed')
    return true
  }

  redo(): boolean {
    if (!this.canRedo() || this.drawing) return false
    this.opStack[this.opIndex]?.redo()
    this.opIndex += 1
    this.emitter.emit('changed')
    return true
  }

  canRedo(): boolean {
    return this.opIndex < this.opStack.length
  }

  canUndo(): boolean {
    return this.opIndex > 0
  }

  private eventMove(event: PointerEvent): void {
    if (!this.acceptsInput(event) || !this.drawing) return
    if (this.model._eventMove(event)) {
      event.stopPropagation()
      event.preventDefault()
      this.emitter.emit('changed')
    }
  }

  private eventStart(event: PointerEvent): void {
    if (!this.acceptsInput(event)) return
    event.stopPropagation()
    event.preventDefault()
    if (this.currentNode) this.cancel()
    this.drawing = true
    this.originalPointerId = event.pointerId
    this.emitter.emit('start')
    this.currentNode = this.model._eventDown(event)
    if (this.currentNode && this.mode !== 'eraseLine') this.el?.appendChild(this.currentNode)
    this.emitter.emit('changed')
  }

  private eventEnd(event: PointerEvent): void {
    if (!this.acceptsInput(event) || !this.drawing) return
    const result = this.model._eventUp(event)
    if (!result) {
      this.cancel()
    } else if (result === true) {
      const node = this.currentNode
      if (node) {
        this._appendNode(node)
        this.commit({
          undo: (): void => {
            this._removeNode(node)
          },
          redo: (): void => {
            this._restoreNode(node)
          },
        })
      }
    } else {
      this.commit(result)
    }
    this.drawing = false
    this.emitter.emit('end')
    this.emitter.emit('changed')
    this.originalPointerId = null
  }

  private touchMove(event: TouchEvent): void {
    // With Apple Pencil "Scribble" enabled, iPadOS only delivers every second
    // stroke unless the touch move for the active stylus is cancelled.
    for (const touch of Array.from(event.touches)) {
      const touchType: unknown = Reflect.get(touch, 'touchType')
      if (touchType === 'stylus' && touch.identifier === this.originalPointerId) {
        event.preventDefault()
        return
      }
    }
  }

  private acceptsInput(event: PointerEvent): boolean {
    const accepted = this.options.acceptsInputTypes
    if (
      accepted &&
      !(isPointerInputType(event.pointerType) && accepted.includes(event.pointerType))
    ) {
      return false
    }
    return this.originalPointerId === null || this.originalPointerId === event.pointerId
  }

  private eventKeyboard(event: KeyboardEvent): void {
    if (this.shiftPressed === event.shiftKey && this.altPressed === event.altKey) return
    this.shiftPressed = event.shiftKey
    this.altPressed = event.altKey
    // Redraw the in-progress shape with the new constraint.
    const point = this.model.point
    if (this.drawing && point && this.model.onMove(point)) this.emitter.emit('changed')
  }

  private commit(op: Operation): void {
    this.opStack.length = this.opIndex
    this.opStack.push(op)
    this.opIndex += 1
    const node = this.currentNode
    this.currentNode = undefined
    this.emitter.emit('committed', node)
  }

  clear(): void {
    this.opStack.length = 0
    this.opIndex = 0
    this.elements = []
    this.cancel()
    if (this.el) this.el.innerHTML = ''
    this.emitter.emit('changed')
  }

  cancel(): void {
    if (this.currentNode) {
      this.currentNode.remove()
      this.currentNode = undefined
      this.emitter.emit('canceled')
    }
  }

  dump(): string {
    return this.el?.innerHTML ?? ''
  }

  load(svg: string): void {
    this.clear()
    if (this.el) this.el.innerHTML = svg
  }

  /** @internal */
  _appendNode(node: SVGElement): void {
    const last = this.elements.at(-1)
    if (last) last.after(node)
    else this.el?.append(node)
    const index = this.elements.push(node) - 1
    node.setAttribute('data-drauu-index', index.toString())
  }

  /** @internal */
  _removeNode(node: Element): void {
    node.remove()
    const index = Number(node.getAttribute('data-drauu-index'))
    if (Number.isInteger(index)) this.elements[index] = null
  }

  /** @internal */
  _restoreNode(node: Element): void {
    const index = Number(node.getAttribute('data-drauu-index'))
    if (!Number.isInteger(index)) return
    this.elements[index] = node
    for (let i = index - 1; i >= 0; i--) {
      const previous = this.elements[i]
      if (previous) {
        previous.after(node)
        return
      }
    }
    this.el?.prepend(node)
  }
}

export function createDrauu(options?: Options): Drauu {
  return new Drauu(options)
}
