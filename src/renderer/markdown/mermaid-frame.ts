import {
  MAX_DIAGRAM_SOURCE_LENGTH,
  MAX_DIAGRAM_DIMENSION,
  parseDiagramSize,
  type DiagramSize,
} from './mermaid-frame-protocol.ts'

const FRAME_TIMEOUT_MS = 30_000
const sources = new WeakMap<HTMLIFrameElement, { source: string; layoutWidth: number }>()

export interface DiagramFrame {
  element: HTMLIFrameElement
  ready: Promise<DiagramSize>
}

/** A fresh opaque-origin realm; only this frame receives the private port. */
export function createMermaidFrame(source: string, layoutWidth = 300): DiagramFrame {
  const element = document.createElement('iframe')
  element.className = 'mermaid-frame'
  element.title = 'Mermaid diagram'
  element.setAttribute('sandbox', 'allow-scripts')
  element.setAttribute('referrerpolicy', 'no-referrer')
  element.setAttribute('tabindex', '-1')
  element.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  )
  const width =
    Number.isFinite(layoutWidth) && layoutWidth > 0
      ? Math.min(layoutWidth, MAX_DIAGRAM_DIMENSION)
      : 300
  element.style.width = `${String(width)}px`
  sources.set(element, { source, layoutWidth: width })
  const ready = new Promise<DiagramSize>((resolve, reject) => {
    if (source.length > MAX_DIAGRAM_SOURCE_LENGTH) {
      reject(new Error('Diagram source is too large'))
      return
    }
    const channel = new MessageChannel()
    const finish = (size: DiagramSize | null): void => {
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      element.onload = null
      element.onerror = null
      if (size) {
        element.style.width = `${String(size.width)}px`
        element.style.aspectRatio = `${String(size.width)} / ${String(size.height)}`
        element.style.height = 'auto'
        element.dataset['rendered'] = 'true'
        resolve(size)
      } else {
        reject(new Error('Diagram frame did not render'))
      }
    }
    const timer = setTimeout(() => {
      finish(null)
    }, FRAME_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<unknown>): void => {
      const size = parseDiagramSize(event.data)
      if (size) finish(size)
      else if (
        typeof event.data === 'object' &&
        event.data !== null &&
        'type' in event.data &&
        event.data.type === 'failed'
      )
        finish(null)
    }
    element.onerror = (): void => {
      finish(null)
    }
    element.onload = (): void => {
      // '*' is required for the opaque origin. The target is this exact window;
      // there is no global message listener or origin-'null' trust decision.
      element.contentWindow?.postMessage({ type: 'render', source }, '*', [channel.port2])
      element.onload = null
    }
    element.src = new URL('./mermaid-frame.html', window.location.href).href
  })
  return { element, ready }
}

/** Expansion gets a fresh frame, never serialized DOM from the original. */
export function recreateMermaidFrame(element: HTMLIFrameElement): DiagramFrame | null {
  const saved = sources.get(element)
  return saved === undefined ? null : createMermaidFrame(saved.source, saved.layoutWidth)
}
