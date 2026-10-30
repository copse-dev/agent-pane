import { createPeleDiagramRenderer } from '@copse/streaming-markdown/diagrams/pele'
import { katexMathRenderer } from '@copse/streaming-markdown/math/katex'
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
        for (const label of node.querySelectorAll<SVGTextElement>('text.pele-label')) {
          const source = /^\$\$([\s\S]+)\$\$$/.exec(label.textContent.trim())?.[1]
          if (!source) continue
          const rendered = await katexMathRenderer.render(source, { displayMode: true })
          const fragment = purifier.sanitize(rendered.html, {
            USE_PROFILES: { mathMl: true },
            FORBID_TAGS: ['annotation-xml', 'maction'],
            FORBID_ATTR: ['href', 'xlink:href'],
            RETURN_DOM_FRAGMENT: true,
          })
          const math = fragment.querySelector('math')
          // Invalid TeX keeps its inert source instead of losing the label.
          if (!math) continue
          const shape =
            label.parentElement?.querySelector<SVGGraphicsElement>('rect, ellipse, polygon')
          const box = (shape ?? label).getBBox()
          if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue
          if (box.width <= 8 || box.height <= 8) continue
          const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
          foreign.classList.add('pele-math-label')
          foreign.setAttribute('x', String(box.x + 4))
          foreign.setAttribute('y', String(box.y + 4))
          foreign.setAttribute('width', String(box.width - 8))
          foreign.setAttribute('height', String(box.height - 8))
          const wrapper = document.createElement('div')
          wrapper.style.cssText =
            'width:100%;height:100%;display:flex;align-items:center;justify-content:center;'
          const style = getComputedStyle(label)
          wrapper.style.color = style.fill
          wrapper.style.fontSize = style.fontSize
          math.setAttribute('display', 'block')
          math.setAttribute('aria-label', source)
          math.style.margin = '0'
          wrapper.append(math)
          foreign.append(wrapper)
          label.after(foreign)
          const available = foreign.getBoundingClientRect()
          const natural = math.getBoundingClientRect()
          if (natural.width > 0 && natural.height > 0) {
            const scale = Math.min(
              1,
              available.width / natural.width,
              available.height / natural.height,
            )
            math.style.transform = `scale(${String(scale)})`
          }
          label.setAttribute('visibility', 'hidden')
          label.setAttribute('aria-hidden', 'true')
        }
      }
    },
  }
}
