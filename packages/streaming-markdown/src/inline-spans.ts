import { decodeEscapedPunctuation, encodeBackslashEscapes } from './backslash-escapes.ts'
import { escapeHtml, escapeHtmlTextNodes } from './escape.ts'
import { renderAngleAutolinks } from './inline-autolinks.ts'
import { renderInlineCode } from './inline-code-spans.ts'
import { INLINE_HTML_SHIELD_RE, renderEmphasisOutsideInlineHtml } from './inline-emphasis.ts'
import { renderInlineLinks, safeLinkHref } from './inline-links.ts'
import { type LinkReferenceMap } from './link-references.ts'

function renderNestedInlineSpans(t: string, linkRefs: LinkReferenceMap): string {
  // Backslash-escaped punctuation is encoded to inert PUA characters first so
  // no later pass can interpret it (encoding is idempotent for nested calls).
  t = encodeBackslashEscapes(t)
  t = renderInlineCode(t)
  t = renderAngleAutolinks(t)
  t = renderStrongAroundCode(t)
  t = renderStrongWithInlineHtml(t)
  t = renderEmphasisOutsideInlineHtml(t, linkRefs)
  t = renderInlineLinks(t, linkRefs, renderNestedInlineSpans)
  t = renderBareHttpLinks(t)
  return t
}

/**
 * Inline span markup (code, emphasis, links) for a single line/segment of
 * already-escaped text. Shared by block rendering and per-cell table rendering
 * so emphasis cannot pair across cell boundaries (#469).
 */
export function renderInlineSpans(t: string, linkRefs: LinkReferenceMap = new Map()): string {
  return decodeEscapedPunctuation(escapeHtmlTextNodes(renderNestedInlineSpans(t, linkRefs)))
}

/** Delimiter stack cannot pair `**` across a `<code>` shield. */
function renderStrongAroundCode(text: string): string {
  return text.replace(/\*\*(<code>[\s\S]*?<\/code>)\*\*/g, '<strong>$1</strong>')
}

/**
 * Strong spans that contain rendered inline HTML with trailing prose. The delimiter
 * stack cannot pair `**` across shields; used for agent captions like
 * `**`file.png` — description**`.
 */
function renderStrongWithInlineHtml(text: string): string {
  return text.replace(
    /\*\*(?=\S)([^*\n]*<(?:code|a|img)\b[\s\S]*?(?:<\/(?:code|a)>|<img\b[^>]*>)[^*\n]*)\*\*/g,
    '<strong>$1</strong>',
  )
}

function renderedBareLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-browser-link="true">${label}</a>`
}

const BARE_HTTP_URL_RE = /(^|[\s(])((?:https?:\/\/)[^\s<]+)/gi
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?_]+$/

function renderBareHttpLinks(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(BARE_HTTP_URL_RE, (_match, prefix: string, rawUrl: string) => {
        const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? ''
        const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
        const href = safeLinkHref(url)
        if (!href) return `${prefix}${rawUrl}`
        return `${prefix}${renderedBareLink(url, href)}${trailing}`
      })
    })
    .join('')
}
