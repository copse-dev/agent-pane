import { escapeHtml } from './escape.ts'
import {
  decodeEscapes,
  lookupLinkReference,
  type LinkReferenceMap,
  parseBracketedLabel,
  parseInlineLinkDestination,
  parseReferenceLabel,
} from './link-references.ts'

export type LinkLabelRenderer = (label: string, refs: LinkReferenceMap) => string

function decodeEscapedHref(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** Allowed link destinations: http(s), mailto, and relative/path forms. Rejects dangerous schemes. */
export function safeLinkHref(raw: string): string | null {
  const href = decodeEscapedHref(raw).trim()
  if (/^(javascript|data|vbscript):/i.test(href)) return null
  if (/^https?:\/\//i.test(href)) return href
  if (/^mailto:/i.test(href)) return href
  if (href === '' || href === '<>') return null
  if (/^[/#.]|^[a-zA-Z0-9]/.test(href)) return href
  return null
}

function renderedLink(label: string, href: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-browser-link="true"${titleAttr}>${label}</a>`
}

function renderedImage(alt: string, src: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} />`
}

function renderLinkLabel(
  label: string,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
): string {
  return renderLabel(decodeEscapes(label), refs)
}

function tryParseLinkOrImage(
  text: string,
  start: number,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
): { html: string; end: number } | null {
  const image = text[start] === '!' && text[start + 1] === '['
  const bracketStart = image ? start + 1 : start
  if (text[bracketStart] !== '[') return null

  const labelPart = parseBracketedLabel(text, bracketStart)
  if (!labelPart) return null

  const j = labelPart.end
  if (text[j] === '(') {
    const dest = parseInlineLinkDestination(text, j)
    if (!dest) return null
    const href = safeLinkHref(dest.href)
    if (!href) return null
    const label = renderLinkLabel(labelPart.label, refs, renderLabel)
    const html = image
      ? renderedImage(label, href, dest.title)
      : renderedLink(label, href, dest.title)
    return { html, end: dest.end }
  }

  if (text[j] === '[') {
    const refLabel = parseReferenceLabel(text, j, labelPart.label)
    if (!refLabel) return null
    const ref = lookupLinkReference(refs, refLabel.label)
    if (!ref) return null
    const href = safeLinkHref(ref.href)
    if (!href) return null
    const label = renderLinkLabel(labelPart.label, refs, renderLabel)
    const html = image
      ? renderedImage(label, href, ref.title)
      : renderedLink(label, href, ref.title)
    return { html, end: refLabel.end }
  }

  // Shortcut reference: `[label]` only when the whole label resolves.
  const ref = lookupLinkReference(refs, labelPart.label)
  if (!ref) return null
  const href = safeLinkHref(ref.href)
  if (!href) return null
  const label = renderLinkLabel(labelPart.label, refs, renderLabel)
  const html = image ? renderedImage(label, href, ref.title) : renderedLink(label, href, ref.title)
  return { html, end: labelPart.end }
}

/** Render markdown inline links and images, respecting code-span boundaries. */
export function renderInlineLinks(
  text: string,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      let out = ''
      let i = 0
      while (i < segment.length) {
        const imageAt = segment[i] === '!' && segment[i + 1] === '['
        const linkAt = segment[i] === '['
        if (imageAt || linkAt) {
          const parsed = tryParseLinkOrImage(segment, i, refs, renderLabel)
          if (parsed) {
            out += parsed.html
            i = parsed.end
            continue
          }
        }
        out += segment[i] ?? ''
        i++
      }
      return out
    })
    .join('')
}

/** Strip app-specific anchor attributes for CommonMark conformance comparison. */
export function stripAppLinkAttributes(html: string): string {
  return html.replace(/<a\b([^>]*?)>/gi, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s+target\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+rel\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+data-browser-link\s*=\s*"[^"]*"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned ? `<a ${cleaned}>` : '<a>'
  })
}
