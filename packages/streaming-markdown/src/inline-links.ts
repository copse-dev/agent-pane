import { decodeEscapedPunctuationRaw } from './backslash-escapes.ts'
import { decodeEscapedHref, escapeHtml } from './escape.ts'
import { isWorkspaceMarkdownLinkHref } from './workspace-link-href.ts'
import {
  encodeHrefForOutput,
  lookupLinkReference,
  type LinkReferenceMap,
  parseInlineLinkDestination,
  parseReferenceLabel,
} from './link-references.ts'

export type LinkLabelRenderer = (label: string, refs: LinkReferenceMap) => string

/** Allowed link destinations: http(s), mailto, and relative/path forms. Rejects dangerous schemes. */
export function safeLinkHref(raw: string): string | null {
  const href = decodeEscapedPunctuationRaw(decodeEscapedHref(raw)).trim()
  if (/^(javascript|data|vbscript):/i.test(href)) return null
  return encodeHrefForOutput(href)
}

/** Resolved link the {@link LinkDecorator} decorates. `href` is already safe/encoded. */
export interface LinkDecoration {
  href: string
  /** True when the destination is an in-workspace path (not http/mailto). */
  isWorkspace: boolean
  title?: string
}

/**
 * Host hook that returns the attribute string appended after `href` on a
 * rendered `<a>` (e.g. ` target="_blank" rel="…" data-browser-link="true"`).
 * Keeps app-specific link decoration out of the parser core so the package can
 * be hosted elsewhere (#601). Replace with {@link setLinkDecorator}.
 */
export type LinkDecorator = (link: LinkDecoration) => string

/**
 * Default decorator — the Copse app's workspace/browser routing, so the package
 * works in-app out of the box. `data-workspace-link` / `data-browser-link` flag
 * links for `workspace-links.ts` / `browser-links.ts`; external links open in a
 * new context. A different host injects its own via {@link setLinkDecorator}.
 */
export const appLinkDecorator: LinkDecorator = ({ isWorkspace, title }) => {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return isWorkspace
    ? ` class="workspace-markdown-link" data-workspace-link="true"${titleAttr}`
    : ` target="_blank" rel="noopener noreferrer" data-browser-link="true"${titleAttr}`
}

let activeLinkDecorator: LinkDecorator = appLinkDecorator

/**
 * Inject a host {@link LinkDecorator}; pass `null` to restore the app default.
 *
 * Note: rendered `<a>` output still passes the escape allowlist
 * (`SAFE_OUTER_TAG_RE` in `escape.ts`) and, at the host sink, DOMPurify
 * (`sanitize.ts`). A decorator that emits attribute *names* outside those
 * allowlists will have them stripped/escaped — widen both allowlists to match a
 * custom decorator's vocabulary (they are the security gate, by design).
 */
export function setLinkDecorator(decorator: LinkDecorator | null): void {
  activeLinkDecorator = decorator ?? appLinkDecorator
}

/** Render an `<a>` for a resolved link, applying the active {@link LinkDecorator}. */
export function renderAnchor(label: string, href: string, title?: string): string {
  const isWorkspace = isWorkspaceMarkdownLinkHref(href)
  // `exactOptionalPropertyTypes`: omit `title` rather than pass an explicit undefined.
  const decoration: LinkDecoration =
    title === undefined ? { href, isWorkspace } : { href, isWorkspace, title }
  const attrs = activeLinkDecorator(decoration)
  return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`
}

function renderedLink(label: string, href: string, title?: string): string {
  return renderAnchor(label, href, title)
}

/**
 * Image `alt` is the plain-text content of the label, not markup. The label is
 * already rendered inline HTML here, so pull nested `<img>` alts through and
 * drop every other tag (`![foo *bar*]` → `foo bar`, spec 574/575/577). The
 * decode/re-escape keeps a single level of entity encoding on nested alts.
 */
function imageAltText(renderedLabel: string): string {
  return renderedLabel
    .replace(/<img\b[^>]*?\salt="([^"]*)"[^>]*>/gi, (_match, nested: string) =>
      decodeEscapedHref(nested),
    )
    .replace(/<[^>]*>/g, '')
}

function renderedImage(alt: string, src: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltText(alt))}"${titleAttr} data-md-rendered="1" />`
}

function renderLinkLabel(
  label: string,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
): string {
  // Label text stays PUA-encoded through nested rendering (inert to all
  // passes); the outer decode pass restores the literal punctuation.
  return renderLabel(label, refs)
}

/** Nested `[` link (not image) inside link label text — forbidden by CommonMark. */
function labelContainsNestedLink(label: string, refs: LinkReferenceMap): boolean {
  let i = 0
  while (i < label.length) {
    if (label[i] === '!' && label[i + 1] === '[') {
      const image = tryParseLinkOrImage(label, i, refs, (inner) => inner)
      if (image) {
        i = image.end
        continue
      }
    }
    if (label[i] === '[') {
      const parsed = tryParseLinkOrImage(label, i, refs, (inner) => inner, { linksOnly: true })
      if (parsed) return true
    }
    i++
  }
  return false
}

/** True when `!`+`[` or `[` begins a link/image that beats emphasis grouping (#521). */
export function linkOrImageStartsAt(
  text: string,
  start: number,
  refs: LinkReferenceMap = new Map(),
): boolean {
  return tryParseLinkOrImage(text, start, refs, (label) => label) !== null
}

/** Bracketed label parse for post-`renderInlineCode` text: `]` inside `<code>` must not close the label (#342, #525, #537). */
function parseBracketedLabelOutsideInlineCode(
  text: string,
  start: number,
): { label: string; end: number } | null {
  if (text[start] !== '[') return null
  const codeRanges = inlineCodeTagRanges(text)
  let i = start + 1
  let depth = 1
  while (i < text.length && depth > 0) {
    const codeRange = codeRangeAt(i, codeRanges)
    if (codeRange) {
      i = codeRange.end
      continue
    }
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') depth--
    i++
  }
  if (depth !== 0) return null
  return { label: text.slice(start + 1, i - 1), end: i }
}

function tryParseLinkOrImage(
  text: string,
  start: number,
  refs: LinkReferenceMap,
  renderLabel: LinkLabelRenderer,
  options: { linksOnly?: boolean } = {},
): { html: string; end: number } | null {
  const image = !options.linksOnly && text[start] === '!' && text[start + 1] === '['
  const bracketStart = image ? start + 1 : start
  if (text[bracketStart] !== '[') return null

  const labelPart = parseBracketedLabelOutsideInlineCode(text, bracketStart)
  if (!labelPart) return null

  const j = labelPart.end
  if (text[j] === '(') {
    const dest = parseInlineLinkDestination(text, j)
    if (!dest) return null
    const href = safeLinkHref(dest.href)
    if (href === null) return null
    if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
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
    if (href === null) return null
    if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
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
  if (href === null) return null
  if (!image && labelContainsNestedLink(labelPart.label, refs)) return null
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
  const codeRanges = inlineCodeTagRanges(text)
  let out = ''
  let i = 0
  while (i < text.length) {
    const codeRange = codeRangeAt(i, codeRanges)
    if (codeRange) {
      out += text.slice(i, codeRange.end)
      i = codeRange.end
      continue
    }
    const imageAt = text[i] === '!' && text[i + 1] === '['
    const linkAt = text[i] === '['
    if (imageAt || linkAt) {
      const parsed = tryParseLinkOrImage(text, i, refs, renderLabel)
      if (parsed) {
        out += parsed.html
        i = parsed.end
        continue
      }
    }
    out += text[i] ?? ''
    i++
  }
  return out
}

const INLINE_CODE_TAG_RE = /<code>[\s\S]*?<\/code>/g

function inlineCodeTagRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const match of text.matchAll(INLINE_CODE_TAG_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function codeRangeAt(
  index: number,
  ranges: { start: number; end: number }[],
): { start: number; end: number } | undefined {
  return ranges.find((range) => index >= range.start && index < range.end)
}

/** Strip app-specific image attributes for CommonMark conformance comparison. */
export function stripAppImageAttributes(html: string): string {
  return html.replace(/ data-md-rendered="1"/g, '')
}

/** Strip app-specific anchor attributes for CommonMark conformance comparison. */
export function stripAppLinkAttributes(html: string): string {
  return html.replace(/<a\b([^>]*?)>/gi, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s+target\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+rel\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+data-browser-link\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+data-workspace-link\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+class\s*=\s*"workspace-markdown-link"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned ? `<a ${cleaned}>` : '<a>'
  })
}
