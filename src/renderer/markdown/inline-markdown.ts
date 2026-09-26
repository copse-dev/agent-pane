import { renderMarkdown } from '@copse/streaming-markdown'

const PHRASING_TAGS = new Set(['CODE', 'EM', 'STRONG', 'S', 'DEL'])

/**
 * Render the small, phrasing-only Markdown subset (`code`, emphasis, strong and
 * strikethrough) into an inline host such as a button, a hint paragraph, or a
 * list row. Copy that names commands, paths, or environment variables in
 * backticks then shows them as inline code rather than as raw delimiters.
 *
 * Raw HTML is escaped, never interpreted, so `<port>`-style placeholders stay
 * literal. Anything the subset cannot express (links, lists, headings, …)
 * leaves the source as plain text: these hosts are controls or single lines,
 * not document containers.
 */
export function setInlineMarkdown(target: HTMLElement, source: string): void {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
  const paragraph = host.firstElementChild
  const isInline =
    host.children.length === 1 &&
    paragraph?.tagName === 'P' &&
    Array.from(paragraph.querySelectorAll('*')).every((node) => PHRASING_TAGS.has(node.tagName))
  if (!paragraph || !isInline) {
    target.textContent = source
    return
  }
  target.replaceChildren(...Array.from(paragraph.childNodes))
}
