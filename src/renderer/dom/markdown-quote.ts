/**
 * Format arbitrary text as a markdown blockquote — one `> ` per line (a bare
 * `>` for a blank line, so the quote stays one continuous block rather than
 * breaking markdown's "blank line ends the blockquote" rule). Used by
 * "Quote in reply" to turn a transcript selection into reply text.
 */
export function formatMarkdownQuote(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}
