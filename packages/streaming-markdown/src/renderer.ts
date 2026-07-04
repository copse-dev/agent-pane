import { tokenizeBlocks } from './block-tokenizer.ts'
import { parseLinkReferenceDefinitions } from './link-references.ts'
import { renderBlocks } from './render-blocks.ts'

export { escapeHtml } from './escape.ts'

/**
 * Render complete markdown to HTML via block tokenization (#475).
 * Fenced code is tokenized as blocks so its contents are not HTML-escaped.
 * HTML comments are stripped from prose blocks only (see render-blocks.ts).
 */
export function renderMarkdown(raw: string): string {
  const linkRefs = parseLinkReferenceDefinitions(raw)
  // htmlFromIndent is set only here (the top-level entry) so indented raw HTML
  // follows the raw-HTML policy instead of becoming a <pre> code block (#616);
  // recursive list/blockquote rendering keeps CommonMark indented-code semantics.
  return renderBlocks(raw, tokenizeBlocks(raw), { linkRefs, htmlFromIndent: true })
}
