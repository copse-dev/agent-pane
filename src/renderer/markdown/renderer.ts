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
  return renderBlocks(raw, tokenizeBlocks(raw), { linkRefs })
}
