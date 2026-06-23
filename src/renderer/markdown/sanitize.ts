import DOMPurify from 'dompurify'

// Defense-in-depth over the hand-assembled HTML that `renderMarkdown()` emits.
// The renderer already escapes prose and validates link hrefs, but it builds
// HTML by string concatenation, which is inherently fragile. Passing every
// rendered fragment through DOMPurify (a vetted, fuzzed sanitizer) before it
// reaches `innerHTML` guarantees that anything outside the small, known set of
// tags/attributes the renderer is supposed to produce — including any payload
// that slips through the regex assembly — is stripped.
//
// The allowlist is intentionally narrow: it mirrors exactly what the renderer
// outputs (prose + GFM tables + highlighted code + mermaid scaffolding). Mermaid
// SVG is generated later, directly by the mermaid library, so it never passes
// through here.
const ALLOWED_TAGS = [
  'a',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'code',
  'pre',
  'span',
  'div',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

// `data-browser-link` flags links the renderer routes through the in-app browser
// (see `browser-links.ts`); `class` carries highlight.js and mermaid hooks.
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'data-browser-link']

/** Sanitize rendered-markdown HTML before it is assigned to `innerHTML`. */
export function sanitizeRenderedMarkdown(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
}
