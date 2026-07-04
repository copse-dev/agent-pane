import { decodeHTMLStrict } from 'entities'
import { canonicalizeEscapedPunctuation } from './backslash-escapes.ts'

/** Parsed link reference definition from block-level `[label]: destination`. */
export interface LinkReference {
  href: string
  title?: string
}

export type LinkReferenceMap = ReadonlyMap<string, LinkReference>

/** CommonMark reference label normalization (whitespace + case fold). */
export function normalizeReferenceLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLocaleLowerCase('und')
}

/** Escape-aware label canonicalization (raw `\!` and PUA forms both → `!`). */
function decodeEscapes(text: string): string {
  return canonicalizeEscapedPunctuation(text)
}

/** Backslash escapes in link destinations (CommonMark: any ASCII punctuation). */
function decodeDestinationEscapes(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
}

function decodeHtmlCharRefs(text: string): string {
  // Full HTML5 named + numeric character references, semicolon required
  // (CommonMark). Escaped-at-source markup is re-encoded by the caller.
  return decodeHTMLStrict(text)
}

/** Percent-encode href values for HTML output (preserves existing %XX sequences). */
export function encodeHrefForOutput(href: string): string {
  const decoded = decodeHtmlCharRefs(href)
  let out = ''
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded.charAt(i)
    if (ch === '%' && /^%[0-9A-Fa-f]{2}/.test(decoded.slice(i, i + 3))) {
      out += decoded.slice(i, i + 3)
      i += 2
      continue
    }
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp < 0x80 && /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/.test(ch)) {
      out += ch
    } else {
      out += encodeURIComponent(ch)
    }
  }
  return out
}

function parseLinkTitleAt(source: string, start: number): { title: string; end: number } | null {
  let i = start
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n')) i++
  const slice = source.slice(i)
  const dquote = slice.match(/^"((?:\\.|[^"\\])*)"/)
  if (dquote?.[1] !== undefined) {
    return {
      title: decodeHtmlCharRefs(decodeDestinationEscapes(dquote[1])),
      end: i + dquote[0].length,
    }
  }
  const squote = slice.match(/^'((?:\\.|[^'\\])*)'/)
  if (squote?.[1] !== undefined) {
    return {
      title: decodeHtmlCharRefs(decodeDestinationEscapes(squote[1])),
      end: i + squote[0].length,
    }
  }
  const paren = slice.match(/^\(((?:\\.|[^)\\])*(?:\\[\s\S])?)\)/)
  if (paren?.[1] !== undefined) {
    return {
      title: decodeHtmlCharRefs(decodeDestinationEscapes(paren[1])),
      end: i + paren[0].length,
    }
  }
  return null
}

function parseDestination(
  source: string,
  start: number,
): { href: string; end: number; title?: string } | null {
  if (source[start] === '<') {
    let i = start + 1
    while (i < source.length) {
      if (source[i] === '\n') return null
      if (source[i] === '\\' && i + 1 < source.length) {
        i += 2
        continue
      }
      if (source[i] === '>') {
        const raw = source.slice(start + 1, i)
        const href = decodeDestinationEscapes(raw)
        const end = i + 1
        const titlePart = parseLinkTitleAt(source, end)
        if (titlePart) {
          return { href, end: titlePart.end, title: titlePart.title }
        }
        return { href, end }
      }
      i++
    }
    return null
  }

  let i = start
  let parenDepth = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === '(') parenDepth++
    else if (ch === ')') {
      if (parenDepth > 0) parenDepth--
      else break
    } else if ((ch === ' ' || ch === '\n' || ch === '\t') && parenDepth === 0) {
      break
    }
    i++
  }
  const raw = source.slice(start, i)
  if (raw === '' || /[ \n\t]/.test(raw)) return null
  const end = i
  const titlePart = parseLinkTitleAt(source, end)
  const href = decodeDestinationEscapes(raw)
  if (titlePart) {
    return { href, end: titlePart.end, title: titlePart.title }
  }
  return { href, end }
}

function parseBracketedLabel(source: string, start: number): { label: string; end: number } | null {
  if (source[start] !== '[') return null
  let i = start + 1
  let depth = 1
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') depth--
    i++
  }
  if (depth !== 0) return null
  const label = source.slice(start + 1, i - 1)
  return { label, end: i }
}

function isLinkReferenceDefStart(source: string, index: number): boolean {
  if (index > 0 && source[index - 1] !== '\n') return false
  let col = 0
  let i = index - 1
  while (i >= 0 && source[i] !== '\n') {
    if (source[i] === '\t') return false
    if (source[i] !== ' ') return false
    col++
    if (col > 3) return false
    i--
  }
  return source[index] === '['
}

/**
 * Scan the document for link reference definitions. First definition wins for a
 * normalized label (#544).
 */
export function parseLinkReferenceDefinitions(source: string): LinkReferenceMap {
  const refs = new Map<string, LinkReference>()
  let i = 0
  while (i < source.length) {
    if (source[i] === '\n') {
      i++
      continue
    }
    if (!isLinkReferenceDefStart(source, i)) {
      i++
      continue
    }
    const labelPart = parseBracketedLabel(source, i)
    if (!labelPart) {
      i++
      continue
    }
    let j = labelPart.end
    while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
    if (source[j] !== ':') {
      i++
      continue
    }
    j++
    // The destination may sit on the next line: spaces/tabs and at most one
    // line ending separate the colon from it (CommonMark ref-def whitespace).
    let sawNewline = false
    while (j < source.length) {
      const c = source[j]
      if (c === ' ' || c === '\t') {
        j++
      } else if (c === '\n' && !sawNewline) {
        sawNewline = true
        j++
      } else {
        break
      }
    }
    const dest = parseDestination(source, j)
    if (!dest) {
      i++
      continue
    }
    // A definition owns the rest of its final line — only trailing whitespace
    // may follow the destination/title, else it is not a definition (#209).
    let tail = dest.end
    while (tail < source.length && (source[tail] === ' ' || source[tail] === '\t')) tail++
    if (tail < source.length && source[tail] !== '\n') {
      i++
      continue
    }
    const key = normalizeReferenceLabel(decodeEscapes(labelPart.label))
    if (!refs.has(key)) {
      const entry: LinkReference = { href: dest.href }
      if (dest.title !== undefined) entry.title = dest.title
      refs.set(key, entry)
    }
    i = dest.end
    while (i < source.length && source[i] !== '\n') i++
  }
  return refs
}

export function lookupLinkReference(
  refs: LinkReferenceMap,
  label: string,
): LinkReference | undefined {
  return refs.get(normalizeReferenceLabel(decodeEscapes(label)))
}

/** Parse inline destination inside `(...)` after a link label. */
export function parseInlineLinkDestination(
  source: string,
  openParenIndex: number,
): { href: string; end: number; title?: string } | null {
  if (source[openParenIndex] !== '(') return null
  let j = openParenIndex + 1
  while (j < source.length && (source[j] === ' ' || source[j] === '\t' || source[j] === '\n')) j++
  if (source[j] === ')') return { href: '', end: j + 1 }
  const dest = parseDestination(source, j)
  if (!dest) return null
  let end = dest.end
  while (
    end < source.length &&
    (source[end] === ' ' || source[end] === '\t' || source[end] === '\n')
  ) {
    end++
  }
  if (source[end] !== ')') return null
  return {
    href: dest.href,
    end: end + 1,
    ...(dest.title !== undefined ? { title: dest.title } : {}),
  }
}

/** Parse second label in `[text][ref]` form; `[]` uses the first label. */
export function parseReferenceLabel(
  source: string,
  openBracketIndex: number,
  fallbackLabel: string,
): { label: string; end: number } | null {
  if (source[openBracketIndex] !== '[') return null
  if (source[openBracketIndex + 1] === ']') {
    return { label: fallbackLabel, end: openBracketIndex + 2 }
  }
  const parsed = parseBracketedLabel(source, openBracketIndex)
  if (!parsed) return null
  return { label: parsed.label, end: parsed.end }
}

export { parseBracketedLabel, decodeEscapes }
