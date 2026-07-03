import { escapeHtml } from './escape.ts'
import { INLINE_HTML_SHIELD_RE } from './inline-emphasis.ts'
import { safeLinkHref } from './inline-links.ts'

/** CommonMark autolink schemes: 2–32 chars, ASCII letter + alnum/.+/- (#609). */
const AUTOLINK_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}$/

function renderedAutolink(label: string, href: string): string {
  // Label stays raw so the outer `escapeHtmlTextNodes` pass escapes it exactly
  // once; pre-escaping here would double-encode `&` in URLs (`&amp;amp;`, #595).
  return `<a href="${escapeHtml(href)}">${label}</a>`
}

/** CommonMark autolink: `<scheme:...>` or `<email@domain>`. No interior whitespace. */
function tryAngleAutolink(text: string, start: number): { html: string; end: number } | null {
  if (text[start] !== '<') return null
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === undefined || ch === '\n' || ch === ' ' || ch === '\t') return null
    if (ch === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }
    if (ch === '>') {
      const inner = text.slice(start + 1, i)
      if (inner.includes(' ')) return null
      const email = inner.match(/^([^@\s]+@[^@\s]+)$/)
      if (email?.[1]) {
        const href = safeLinkHref(`mailto:${email[1]}`)
        if (!href) return null
        return { html: renderedAutolink(inner, href), end: i + 1 }
      }
      const colon = inner.indexOf(':')
      if (colon === -1) return null
      if (!AUTOLINK_SCHEME_RE.test(inner.slice(0, colon))) return null
      const href = safeLinkHref(inner)
      if (!href) return null
      return { html: renderedAutolink(inner, href), end: i + 1 }
    }
    i++
  }
  return null
}

/** Render `<url>` and `<email>` autolinks outside inline HTML shields. */
export function renderAngleAutolinks(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      let out = ''
      let i = 0
      while (i < segment.length) {
        const parsed = tryAngleAutolink(segment, i)
        if (parsed) {
          out += parsed.html
          i = parsed.end
          continue
        }
        out += segment[i] ?? ''
        i++
      }
      return out
    })
    .join('')
}
