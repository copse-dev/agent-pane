// Faithful port of the CommonMark reference HTML normalizer used by the spec's
// conformance runner (`commonmark-spec/test/normalize.py`). We compare our
// renderer's output against the spec's expected HTML *after* normalizing both
// sides the same way the reference suite does, so insignificant differences
// (whitespace around block tags, self-closing vs open tags, attribute order,
// decoded character references) do not register as failures.
//
// The port intentionally mirrors `normalize.py` rather than using a DOM parser
// so the comparison stays identical to upstream: collapse inner whitespace
// (except inside <pre>), strip whitespace around block-level tags, drop the '\n'
// directly after <br>, sort attributes, lower-case tag/attribute names, expand
// self-closing tags, and decode character references back to text while keeping
// <, >, &, and " as entities.
//
// Source: https://github.com/commonmark/commonmark-spec/blob/master/test/normalize.py
// (adapted from https://github.com/karlcow/markdown-testsuite/)

const BLOCK_TAGS = new Set([
  'article',
  'header',
  'aside',
  'hgroup',
  'blockquote',
  'hr',
  'iframe',
  'body',
  'li',
  'map',
  'button',
  'object',
  'canvas',
  'ol',
  'caption',
  'output',
  'col',
  'p',
  'colgroup',
  'pre',
  'dd',
  'progress',
  'div',
  'section',
  'dl',
  'table',
  'td',
  'dt',
  'tbody',
  'embed',
  'textarea',
  'fieldset',
  'tfoot',
  'figcaption',
  'th',
  'figure',
  'thead',
  'footer',
  'tr',
  'form',
  'ul',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'video',
  'script',
  'style',
])

// The spec's expected HTML and our renderer's output only ever emit this small
// set of named references; everything else (the big "Entity and numeric
// character references" section) decodes to literal unicode in the expected
// HTML, so an unknown name faithfully falls back to its literal `&name;` form
// exactly like Python's `name2codepoint` KeyError path.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ouml: '\u00f6',
}

type Attr = [string, string | null]

interface ParsedStartTag {
  tag: string
  attrs: Attr[]
  selfClosing: boolean
}

const WHITESPACE_RE = /\s+/g
const LEADING_WS_RE = /^\s+/
const TRAILING_WS_RE = /\s+$/

class HtmlNormalizer {
  private out = ''
  private last: 'starttag' | 'endtag' | 'data' | 'comment' | 'decl' | 'pi' | 'ref' = 'starttag'
  private lastTag = ''
  private inPre = false

  result(): string {
    return this.out
  }

  data(raw: string): void {
    if (raw === '') return
    let data = raw
    const afterTag = this.last === 'endtag' || this.last === 'starttag'
    const afterBlockTag = afterTag && BLOCK_TAGS.has(this.lastTag)
    if (afterTag && this.lastTag === 'br') data = data.replace(/^\n+/, '')
    if (!this.inPre) data = data.replace(WHITESPACE_RE, ' ')
    if (afterBlockTag && !this.inPre) {
      if (this.last === 'starttag') data = data.replace(LEADING_WS_RE, '')
      else if (this.last === 'endtag')
        data = data.replace(LEADING_WS_RE, '').replace(TRAILING_WS_RE, '')
    }
    this.out += data
    this.last = 'data'
  }

  startTag(tag: string, attrs: Attr[]): void {
    if (tag === 'pre') this.inPre = true
    if (BLOCK_TAGS.has(tag)) this.out = this.out.replace(TRAILING_WS_RE, '')
    this.out += '<' + tag
    const sorted = [...attrs].sort(compareAttr)
    for (const [k, v] of sorted) {
      this.out += ' ' + k
      if (v !== null) this.out += '="' + escapeAttr(v) + '"'
    }
    this.out += '>'
    this.lastTag = tag
    this.last = 'starttag'
  }

  endTag(tag: string): void {
    if (tag === 'pre') this.inPre = false
    else if (BLOCK_TAGS.has(tag)) this.out = this.out.replace(TRAILING_WS_RE, '')
    this.out += '</' + tag + '>'
    this.lastTag = tag
    this.last = 'endtag'
  }

  selfClosing(tag: string, attrs: Attr[]): void {
    this.startTag(tag, attrs)
    this.lastTag = tag
    this.last = 'endtag'
  }

  verbatim(text: string): void {
    this.out += text
    this.last = 'comment'
  }

  entityRef(name: string): void {
    const decoded = NAMED_ENTITIES[name]
    this.outputChar(decoded ?? null, '&' + name + ';')
    this.last = 'ref'
  }

  charRef(spec: string): void {
    let code: number | null
    try {
      code = spec[0] === 'x' || spec[0] === 'X' ? parseInt(spec.slice(1), 16) : parseInt(spec, 10)
      if (!Number.isFinite(code)) code = null
    } catch {
      code = null
    }
    let ch: string | null = null
    if (code !== null) {
      try {
        ch = String.fromCodePoint(code)
      } catch {
        ch = null
      }
    }
    this.outputChar(ch, '&#' + spec + ';')
    this.last = 'ref'
  }

  private outputChar(c: string | null, fallback: string): void {
    if (c === '<') this.out += '&lt;'
    else if (c === '>') this.out += '&gt;'
    else if (c === '&') this.out += '&amp;'
    else if (c === '"') this.out += '&quot;'
    else if (c === null) this.out += fallback
    else this.out += c
  }
}

function compareAttr(a: Attr, b: Attr): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  const av = a[1] ?? ''
  const bv = b[1] ?? ''
  if (av === bv) return 0
  return av < bv ? -1 : 1
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g

// HTMLParser decodes character references inside attribute values; we mirror
// that (decode, then `escapeAttr` re-encodes the markup-significant chars) so an
// attribute like `title="a &quot; b"` normalizes identically on both sides.
function decodeRefs(value: string): string {
  return value
    .replace(/&#([xX][0-9a-fA-F]+|[0-9]+);?/g, (_m, spec: string) => {
      const code =
        spec[0] === 'x' || spec[0] === 'X' ? parseInt(spec.slice(1), 16) : parseInt(spec, 10)
      if (!Number.isFinite(code)) return _m
      try {
        return String.fromCodePoint(code)
      } catch {
        return _m
      }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (_m, name: string) => NAMED_ENTITIES[name] ?? _m)
}

function parseAttrs(raw: string): Attr[] {
  const attrs: Attr[] = []
  for (const m of raw.matchAll(ATTR_RE)) {
    // Group 1 is a mandatory capture in ATTR_RE, so it is always present when
    // the regex matches; guard only to satisfy the type checker.
    if (m[1] === undefined) continue
    const name = m[1].toLowerCase()
    let value = m[2]
    if (value === undefined) {
      attrs.push([name, null])
      continue
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    attrs.push([name, decodeRefs(value)])
  }
  return attrs
}

function parseStartTag(inner: string): ParsedStartTag | null {
  const m = inner.match(/^([a-zA-Z][^\s/>]*)([\s\S]*?)(\/?)$/)
  if (!m) return null
  // Groups 1 and 2 are mandatory captures, always present on a successful match.
  const tag = m[1]
  const attrs = m[2]
  if (tag === undefined || attrs === undefined) return null
  return { tag: tag.toLowerCase(), attrs: parseAttrs(attrs), selfClosing: m[3] === '/' }
}

/** Normalize HTML the same way the CommonMark spec conformance runner does. */
export function normalizeHtml(html: string): string {
  const n = new HtmlNormalizer()
  let i = 0
  let textBuf = ''
  const flush = (): void => {
    if (textBuf) {
      n.data(textBuf)
      textBuf = ''
    }
  }
  while (i < html.length) {
    const ch = html[i]
    // i < html.length guarantees an in-bounds character; guard for the type checker.
    if (ch === undefined) break
    if (html.startsWith('<![CDATA[', i)) {
      flush()
      const end = html.indexOf(']]>', i)
      const stop = end === -1 ? html.length : end + 3
      n.verbatim(html.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '<') {
      const close = html.indexOf('>', i)
      if (close === -1) {
        textBuf += ch
        i++
        continue
      }
      const tagText = html.slice(i, close + 1)
      flush()
      if (tagText.startsWith('<!--')) {
        const end = html.indexOf('-->', i)
        const stop = end === -1 ? html.length : end + 3
        n.verbatim(html.slice(i, stop))
        i = stop
        continue
      }
      const inner = tagText.slice(1, -1)
      if (inner.startsWith('!') || inner.startsWith('?')) {
        n.verbatim(tagText)
        i = close + 1
        continue
      }
      if (inner.startsWith('/')) {
        const tag = inner.slice(1).trim().toLowerCase()
        n.endTag(tag)
        i = close + 1
        continue
      }
      const parsed = parseStartTag(inner)
      if (!parsed) {
        textBuf += tagText
        i = close + 1
        continue
      }
      if (parsed.selfClosing) n.selfClosing(parsed.tag, parsed.attrs)
      else n.startTag(parsed.tag, parsed.attrs)
      i = close + 1
      continue
    }
    if (ch === '&') {
      const charMatch = html.slice(i).match(/^&#([xX][0-9a-fA-F]+|[0-9]+);?/)
      if (charMatch?.[1] !== undefined) {
        flush()
        n.charRef(charMatch[1])
        i += charMatch[0].length
        continue
      }
      const nameMatch = html.slice(i).match(/^&([a-zA-Z][a-zA-Z0-9]*);?/)
      if (nameMatch?.[1] !== undefined) {
        flush()
        n.entityRef(nameMatch[1])
        i += nameMatch[0].length
        continue
      }
    }
    textBuf += ch
    i++
  }
  flush()
  return n.result()
}
