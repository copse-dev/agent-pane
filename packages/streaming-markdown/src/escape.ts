const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Order-independent HTML text encoder. A single pass over a character class
 * (with `&` handled by the same regex) avoids the escape-ordering coupling that
 * an earlier `.replace('&').replace('<')...` chain depended on, and also encodes
 * quotes so untrusted text can never break out into an attribute context.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

const SAFE_OUTER_TAG_RE =
  /^(?:<a(?:\s+href="[^"]*")(?:\s+(?:title|target|rel|data-browser-link|data-workspace-link|class)="[^"]*")*\s*>|<\/(?:a|code|em|strong)>|<(?:code|em|strong)\b[^>]*>|<img\b[^>]*(?:\bdata-md-rendered="1"|\bclass="remote-artifact-image")[^>]*\/?>)$/i

/**
 * Benign raw inline HTML models emit in prose (strikethrough, sub/superscript,
 * keyboard keys, explicit breaks). Attribute-less phrasing tags only — anything
 * with attributes, and all block/structural tags, stays escaped. The DOMPurify
 * sink allowlist (`sanitize.ts`) mirrors this set.
 */
const BENIGN_RAW_INLINE_TAG_RE = /^<\/?(?:b|i|u|s|del|ins|sub|sup|kbd|mark|br)\s*\/?>$/i

function escapeHtmlOutsideSafeTags(html: string): string {
  return html
    .split(/(<[^>]+>)/g)
    .map((part) =>
      part.startsWith('<') && (SAFE_OUTER_TAG_RE.test(part) || BENIGN_RAW_INLINE_TAG_RE.test(part))
        ? part
        : escapeHtml(part),
    )
    .join('')
}

/** Escape literal text while preserving Copse-generated inline HTML tags. */
export function escapeHtmlTextNodes(html: string): string {
  return html
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) {
        const match = segment.match(/^(<code>)([\s\S]*?)(<\/code>)$/)
        if (!match) return segment
        return `${match[1] ?? ''}${escapeHtml(match[2] ?? '')}${match[3] ?? ''}`
      }
      return escapeHtmlOutsideSafeTags(segment)
    })
    .join('')
}

/**
 * Mermaid reads arrow syntax (`-->`) so `>` must survive, but everything that
 * could break out of `<pre>` (`&`, `<`, and both quote styles) is still encoded
 * in one order-independent pass.
 */
export function escapeMermaidHtml(text: string): string {
  return text.replace(/[&<"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/** Reverse {@link escapeHtml} for parsing href/src attributes embedded in markdown. */
export function decodeEscapedHref(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const SAFE_MARKDOWN_ENTITY_RE = /&(?:amp;)?(?:nbsp|#160|#x0*a);/gi

const KNOWN_SAFE_ENTITIES = [
  '&nbsp;',
  '&#160;',
  '&#xa0;',
  '&amp;nbsp;',
  '&amp;#160;',
  '&amp;#xa0;',
] as const

/** Drop a trailing incomplete safe-entity prefix so streaming never flashes literal `&nbsp`. */
export function stripIncompleteSafeEntities(text: string): string {
  const amp = text.lastIndexOf('&')
  if (amp === -1) return text
  const suffix = text.slice(amp)
  if (/^&(?:amp;)?(?:nbsp|#160|#x0*a);$/i.test(suffix)) return text
  const lower = suffix.toLowerCase()
  if (
    KNOWN_SAFE_ENTITIES.some((entity) => entity.startsWith(lower) && lower.length < entity.length)
  ) {
    return text.slice(0, amp)
  }
  return text
}

/** Decode a small allowlist of HTML entities models emit in prose (e.g. &nbsp;). */
export function decodeSafeMarkdownEntities(text: string): string {
  const stripped = stripIncompleteSafeEntities(text)
  return stripped.replace(SAFE_MARKDOWN_ENTITY_RE, (entity) => {
    const lower = entity.toLowerCase()
    if (
      lower === '&nbsp;' ||
      lower === '&#160;' ||
      lower === '&#xa0;' ||
      lower === '&amp;nbsp;' ||
      lower === '&amp;#160;' ||
      lower === '&amp;#xa0;'
    ) {
      return '\u00A0'
    }
    return entity
  })
}
