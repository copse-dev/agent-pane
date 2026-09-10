// Test-only bundle: deliberately runs the same renderer in the parent to compare
// the previous DOM placement with the isolated integration on the same machine.
import { renderMermaidInFrame } from '../../../src/renderer/markdown/mermaid-render.ts'
import { renderMermaidIn } from '../../../src/renderer/markdown/mermaid.ts'
import { renderMarkdown, StreamingMarkdownRenderer } from '@copse/streaming-markdown'

function mount(): HTMLElement {
  document.querySelector('dialog[open]')?.remove()
  const app = document.getElementById('app')!
  const root = document.createElement('div')
  root.id = 'parity'
  root.style.cssText = 'padding:16px;overflow:auto;width:100%;height:100%;box-sizing:border-box;'
  app.replaceChildren(root)
  return root
}

function column(root: HTMLElement, id: string, title: string): HTMLElement {
  const section = document.createElement('section')
  section.style.cssText = 'min-width:0;flex:1;'
  const heading = document.createElement('h3')
  heading.textContent = title
  const body = document.createElement('div')
  body.className = 'message-text streaming-markdown'
  body.id = id
  section.append(heading, body)
  root.append(section)
  return body
}

Reflect.set(window, 'mermaidParity', {
  async pair(source: string, title: string) {
    const root = mount()
    root.style.display = 'flex'
    root.style.gap = '20px'
    const baseline = column(root, 'baseline', `${title}: parent rendering`)
    const isolated = column(root, 'isolated', `${title}: isolated rendering`)
    const markdown = `\`\`\`mermaid\n${source}\n\`\`\``
    baseline.innerHTML = renderMarkdown(markdown)
    isolated.innerHTML = renderMarkdown(markdown)
    await renderMermaidInFrame(baseline)
    baseline.querySelector('.mermaid-diagram')?.classList.add('mermaid-diagram--folded')
    await renderMermaidIn(isolated)
  },
  async stream() {
    const root = mount()
    const host = column(root, 'isolated', 'Streaming Mermaid')
    const renderer = new StreamingMarkdownRenderer(host)
    const content =
      'Introduction\n\n```mermaid\ngraph LR\nA[Start] --> B[Finish]\n```\n\nAfter diagram.'
    let prematureFrames = 0
    for (let end = 1; end <= content.length; end++) {
      renderer.update(content.slice(0, end))
      prematureFrames += host.querySelectorAll('iframe').length
    }
    // Mirrors conversation.ts: hydration runs only on the final render.
    host.innerHTML = renderMarkdown(content)
    await renderMermaidIn(host)
    return {
      prematureFrames,
      frames: host.querySelectorAll('iframe').length,
      text: host.textContent,
    }
  },
  async many(count: number) {
    const root = mount()
    const host = column(root, 'isolated', `${count} diagrams`)
    host.innerHTML = renderMarkdown(
      Array.from(
        { length: count },
        (_, i) => `\`\`\`mermaid\ngraph LR\nA[Diagram ${i}] --> B[Done]\n\`\`\``,
      ).join('\n\n'),
    )
    const start = performance.now()
    await renderMermaidIn(host)
    return {
      ms: performance.now() - start,
      frames: host.querySelectorAll('iframe[data-rendered="true"]').length,
      fallbacks: host.querySelectorAll('.mermaid-fallback-title').length,
    }
  },
})
