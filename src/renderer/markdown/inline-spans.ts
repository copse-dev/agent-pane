import { escapeHtml } from './escape.ts'
import { renderEmphasisOutsideInlineHtml } from './inline-emphasis.ts'

/**
 * Inline span markup (code, emphasis, links) for a single line/segment of
 * already-escaped text. Shared by block rendering and per-cell table rendering
 * so emphasis cannot pair across cell boundaries (#469).
 */
export function renderInlineSpans(t: string): string {
  t = renderInlineCode(t)
  t = renderStrongAroundCode(t)
  t = renderStrongWithInlineHtml(t)
  t = renderEmphasisOutsideInlineHtml(t)
  t = renderMarkdownLinks(t)
  t = renderBareHttpLinks(t)
  return t
}

/**
 * CommonMark code spans: a run of N backticks opens a span that closes at the
 * next run of exactly N backticks. Interior line endings collapse to spaces.
 */
function renderInlineCode(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '`') {
      out += ch ?? ''
      i++
      continue
    }
    let runEnd = i
    while (text[runEnd] === '`') runEnd++
    const fence = runEnd - i
    let close = -1
    let k = runEnd
    while (k < text.length) {
      if (text[k] !== '`') {
        k++
        continue
      }
      let l = k
      while (text[l] === '`') l++
      if (l - k === fence) {
        close = k
        break
      }
      k = l
    }
    if (close === -1) {
      out += text.slice(i, runEnd)
      i = runEnd
      continue
    }
    let content = text.slice(runEnd, close).replace(/\n/g, ' ')
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      /[^ ]/.test(content)
    ) {
      content = content.slice(1, -1)
    }
    out += `<code>${content}</code>`
    i = close + fence
  }
  return out
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

function safeLinkHref(raw: string): string | null {
  const href = decodeEscapedHref(raw).trim()
  if (/^https?:\/\//i.test(href)) return href
  return null
}

function decodeEscapedHref(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function renderedLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-browser-link="true">${label}</a>`
}

function renderMarkdownLinks(text: string): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
        const href = safeLinkHref(url)
        if (!href) return `[${label}](${url})`
        return renderedLink(label, href)
      })
    })
    .join('')
}

const BARE_HTTP_URL_RE = /(^|[\s(])((?:https?:\/\/)[^\s<]+)/gi
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?_]+$/

function renderBareHttpLinks(text: string): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(BARE_HTTP_URL_RE, (_match, prefix: string, rawUrl: string) => {
        const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? ''
        const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
        const href = safeLinkHref(url)
        if (!href) return `${prefix}${rawUrl}`
        return `${prefix}${renderedLink(url, href)}${trailing}`
      })
    })
    .join('')
}
