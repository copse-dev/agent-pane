import { createPeleDiagramRenderer } from '@copse/streaming-markdown/diagrams/pele'
import type { FrameMermaid } from '@copse/streaming-markdown/diagrams/mermaid/frame'
import DOMPurify from 'dompurify'

/** Adapt Pele to the package's isolated frame protocol; SVG never enters the app DOM. */
export function createPeleFrameBackend(): FrameMermaid {
  let renderer = createPeleDiagramRenderer({ fontFamily: 'Pliant' })
  return {
    initialize({ fontFamily, maxTextSize }): void {
      renderer = createPeleDiagramRenderer({ fontFamily, limit: maxTextSize })
    },
    async run({ nodes }): Promise<void> {
      const purifier = DOMPurify(window)
      for (const node of nodes) {
        const { svg } = await renderer.render(node.textContent)
        node.innerHTML = purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      }
    },
  }
}
