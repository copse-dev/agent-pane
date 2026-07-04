/**
 * Detection + dedent for top-level indented HTML blocks that CommonMark would
 * otherwise capture as indented code (#616).
 *
 * Models sometimes emit raw HTML (`<div>`, `<table>`) indented four-plus spaces.
 * The block tokenizer classifies those lines as an `indented_code` block, so
 * they render as a literal `<pre><code>` dump instead of following the raw-HTML
 * policy (escaped/benign prose — see #600). When such a block appears at the top
 * level we reclassify it as prose so it matches its un-indented equivalent.
 *
 * This is only ever applied to **top-level** blocks: list- and blockquote-nested
 * indented content is tokenized recursively, so a top-level `indented_code`
 * token is provably not inside a list item, and CommonMark's "4 spaces = code"
 * rule still holds for genuinely-nested indented code.
 */

// CommonMark HTML-block (type 6) tag list — the block-level element names that
// start a raw HTML block. Using this set (rather than "any tag") keeps genuine
// indented code that merely opens with an inline tag — e.g. `    <a/>` followed
// by markdown (spec example #110) — classified as code.
const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'

// An open or close block-level HTML tag at the start of a line: `<div`,
// `</table>`, `<section class=…>`.
const HTML_BLOCK_START_RE = new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, 'i')

/** Leading-space width of a line (spaces only; indented code is space-indented). */
function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0
}

/** Remove the smallest shared leading-space indent across all non-blank lines. */
export function dedentBlock(content: string): string {
  const lines = content.split('\n')
  let min = Infinity
  for (const line of lines) {
    if (line.trim() === '') continue
    min = Math.min(min, leadingSpaces(line))
  }
  if (!Number.isFinite(min) || min === 0) return content
  return lines.map((line) => line.slice(Math.min(min, leadingSpaces(line)))).join('\n')
}

/**
 * True when an indented-code slice is actually a raw HTML block: after removing
 * its shared indentation, the first non-blank line opens with an HTML tag.
 */
export function isIndentedHtmlBlock(content: string): boolean {
  const first = dedentBlock(content)
    .split('\n')
    .find((line) => line.trim() !== '')
  return first !== undefined && HTML_BLOCK_START_RE.test(first)
}
