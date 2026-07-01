import { parseOpenFenceContent } from './block-patterns.ts'
import { escapeMermaidHtml } from './escape.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

const FORMING_FENCE_PRE_CLASS = 'stream-fence-forming'

function renderFormingFenceInner(lang: string, code: string): string {
  if (lang === 'mermaid') {
    const body = escapeMermaidHtml(code)
    return `<div class="mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="mermaid">${body}</pre></div>`
  }
  const body = highlightFenceCode(code, lang)
  return `<pre class="${FORMING_FENCE_PRE_CLASS}"><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

/** Build forming-fence HTML for the string streaming API. */
export function buildFormingFenceHtml(source: string): string {
  const parsed = parseOpenFenceContent(source)
  if (!parsed) return ''
  return sanitizeRenderedMarkdown(renderFormingFenceInner(parsed.lang, parsed.code))
}

/** Forward-pass DOM updates for a fenced code block still streaming. */
export function syncFormingFenceDom(container: HTMLElement, source: string): void {
  const parsed = parseOpenFenceContent(source)
  if (!parsed) {
    container.replaceChildren()
    return
  }

  const { lang, code } = parsed
  if (lang === 'mermaid') {
    let diagram = container.querySelector<HTMLElement>(
      `.mermaid-diagram.${FORMING_FENCE_PRE_CLASS}`,
    )
    if (!diagram) {
      container.replaceChildren()
      diagram = document.createElement('div')
      diagram.className = `mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}`
      const pre = document.createElement('pre')
      pre.className = 'mermaid'
      diagram.append(pre)
      container.append(diagram)
    }
    const pre = diagram.querySelector('pre.mermaid')
    if (pre) pre.textContent = code
    return
  }

  let pre = container.querySelector<HTMLPreElement>(`pre.${FORMING_FENCE_PRE_CLASS}`)
  if (!pre) {
    container.replaceChildren()
    pre = document.createElement('pre')
    pre.className = FORMING_FENCE_PRE_CLASS
    const codeEl = document.createElement('code')
    pre.append(codeEl)
    container.append(pre)
  }
  const codeEl = pre.querySelector('code')
  if (codeEl) {
    codeEl.className = fenceCodeClass(lang)
    codeEl.innerHTML = sanitizeRenderedMarkdown(highlightFenceCode(code, lang))
  }
}

export function clearFormingFenceDom(container: HTMLElement): void {
  container.replaceChildren()
}
