import {
  createMermaidFrame as createIsolatedMermaidFrame,
  type DiagramFrame,
} from '@copse/streaming-markdown/diagrams/mermaid/isolated'

export type { DiagramFrame } from '@copse/streaming-markdown/diagrams/mermaid/isolated'

const sources = new WeakMap<HTMLIFrameElement, { source: string; layoutWidth: number }>()

/** Copse owns packaged asset routing and expansion; the package owns isolation. */
export function createMermaidFrame(source: string, layoutWidth = 300): DiagramFrame {
  const frame = createIsolatedMermaidFrame(source, {
    url: new URL('./mermaid-frame.html', window.location.href).href,
    layoutWidth,
  })
  sources.set(frame.element, { source, layoutWidth })
  return frame
}

/** Expansion gets a fresh frame, never serialized DOM from the original. */
export function recreateMermaidFrame(element: HTMLIFrameElement): DiagramFrame | null {
  const saved = sources.get(element)
  return saved === undefined ? null : createMermaidFrame(saved.source, saved.layoutWidth)
}
