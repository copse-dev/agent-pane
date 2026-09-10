import { renderMermaidInFrame } from './mermaid-render.ts'
import { parseDiagramSource } from './mermaid-frame-protocol.ts'
import regularFont from '../../../assets/fonts/Pliant-Variable.ttf'
import italicFont from '../../../assets/fonts/Pliant-Italic-Variable.ttf'

async function loadPliant(): Promise<void> {
  const fonts = [
    { source: regularFont, style: 'normal' },
    { source: italicFont, style: 'italic' },
  ]
  await Promise.all(
    fonts.map(async ({ source, style }) => {
      // Binary FontFace sources do not fetch a URL. Keep font-src 'none'; these
      // are the same bundled font bytes used by chat, inside the hashed script.
      const bytes = Uint8Array.from(atob(source), (character) => character.charCodeAt(0))
      const font = new FontFace('Pliant', bytes, { style, weight: '100 900' })
      document.fonts.add(await font.load())
    }),
  )
}

// Bundled independently. This realm has no preload, app store, or native API.
async function render(source: string, port: MessagePort): Promise<void> {
  try {
    // Mermaid measures labels during layout. Never measure a fallback face and
    // swap in Pliant afterwards, which would clip labels or move their edges.
    await loadPliant()
    const diagram = document.createElement('div')
    diagram.className = 'mermaid-diagram'
    const pre = document.createElement('pre')
    pre.className = 'mermaid'
    pre.textContent = source
    diagram.append(pre)
    document.body.replaceChildren(diagram)
    await renderMermaidInFrame(diagram)
    const svg = diagram.querySelector('svg')
    if (!svg || diagram.querySelector('.mermaid-fallback-title')) throw new Error('No diagram')
    const box = svg.viewBox.baseVal
    const width = box.width || svg.getBoundingClientRect().width
    const height = box.height || svg.getBoundingClientRect().height
    svg.style.width = '100%'
    svg.style.height = '100%'
    svg.style.maxWidth = 'none'
    port.postMessage({ type: 'rendered', width, height })
  } catch {
    port.postMessage({ type: 'failed' })
  } finally {
    port.close()
  }
}

function receive(event: MessageEvent<unknown>): void {
  if (event.source !== window.parent || event.ports.length !== 1) return
  const source = parseDiagramSource(event.data)
  const port = event.ports[0]
  if (source === null || !port) return
  window.removeEventListener('message', receive)
  void render(source, port)
}
window.addEventListener('message', receive)
