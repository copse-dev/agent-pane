import { attachMermaidExpand } from './mermaid-expand.ts'
import { renderMermaidFallback } from './mermaid-fallback.ts'
import { createMermaidFrame } from './mermaid-frame.ts'

/** Only inert source text crosses into a separate Mermaid execution realm. */
export async function renderMermaidIn(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])')
  await Promise.all(
    Array.from(nodes, async (node) => {
      const container = node.closest<HTMLElement>('.mermaid-diagram')
      if (!container) return
      node.dataset['processed'] = 'true'
      const source = node.textContent
      const style = getComputedStyle(node)
      const layoutWidth =
        node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const frame = createMermaidFrame(source, layoutWidth)
      // Keep the original pre's padding and responsive Markdown styles.
      node.replaceChildren(frame.element)
      try {
        await frame.ready
        attachMermaidExpand(container.parentElement ?? root)
      } catch {
        frame.element.remove()
        renderMermaidFallback(container, source)
      }
    }),
  )
}
