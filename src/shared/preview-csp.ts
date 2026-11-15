/** CSP embedded in self-contained HTML artefacts. */
export const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  // Self-contained drawing workers inherit this policy and the data: document's
  // opaque origin. No remote worker script, eval, or network origin is allowed.
  'worker-src blob:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** First in the document: untrusted HTML cannot precede or relax this policy. */
export function securePreviewHtml(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${html}`
}

/** A script or stylesheet a preview document asks for that {@link PREVIEW_CSP} refuses. */
export interface PreviewBlockedLoad {
  kind: 'script' | 'stylesheet'
  url: string
}

// Every quantifier in these body patterns is bounded, so a hostile 512 KB
// document costs a bounded amount of work per occurrence of the keyword.
const IMPORT_FROM = /\b(?:import|export)\b[^;"'`()]{0,500}?\bfrom\s{0,50}(["'])([^"'\n]{1,2048})\1/g
const SIDE_EFFECT_IMPORT = /\bimport\s{0,50}(["'])([^"'\n]{1,2048})\1/g
const DYNAMIC_IMPORT = /\bimport\s{0,50}\(\s{0,50}(["'`])([^"'`\n]{1,2048})\1\s{0,50}\)/g
const CSS_IMPORT = /@import\s{1,50}(?:url\(\s{0,50})?(["']?)([^"')\s;]{1,2048})\1/gi
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

type ScannedTag = 'script' | 'style' | 'link'
const SCANNED_TAGS: readonly ScannedTag[] = ['script', 'style', 'link']

/** The scanned tag that opens at `index` (just past `<`), if any. */
function scannedTagAt(lower: string, index: number): ScannedTag | null {
  for (const name of SCANNED_TAGS) {
    if (!lower.startsWith(name, index)) continue
    const next = lower.charAt(index + name.length)
    if (next === '' || next === '>' || next === '/' || /\s/.test(next)) return name
  }
  return null
}

/** Index of the `>` closing a start tag, skipping quoted attribute values; -1 if none. */
function startTagEnd(html: string, from: number): number {
  let quote = ''
  for (let index = from; index < html.length; index++) {
    const char = html.charAt(index)
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function tagAttributes(text: string): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase()
    // The HTML parser keeps the first of a repeated attribute.
    if (name && !parsed.has(name)) {
      parsed.set(name, (match[2] ?? match[3] ?? match[4] ?? '').trim())
    }
  }
  return parsed
}

/**
 * The external scripts and stylesheets a preview document references. The
 * document renders as an opaque `data:` origin, so `'self'` matches nothing and
 * {@link PREVIEW_CSP} lets only inline `<script>` and `<style>` code run: every
 * load listed here is refused.
 *
 * Advisory only. It lets a tool tell its caller why a page is missing its
 * library instead of the load failing silently. The CSP stays the boundary; a
 * load this static scan cannot see, such as a script element created at
 * runtime, is still refused, just not reported.
 *
 * A single linear pass rather than whole-document regular expressions: the
 * input is untrusted and as large as 512 KB, and a pattern such as
 * `<script[^>]*>[\s\S]*?</script>` is quadratic over many unclosed tags.
 */
export function findPreviewBlockedLoads(html: string): PreviewBlockedLoad[] {
  // ASCII-only, so every index into `lower` is the same index into `html`.
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase())
  const loads: PreviewBlockedLoad[] = []
  const seen = new Set<string>()
  const add = (kind: PreviewBlockedLoad['kind'], url: string | undefined): void => {
    if (!url) return
    const key = `${kind} ${url}`
    if (seen.has(key)) return
    seen.add(key)
    loads.push({ kind, url })
  }

  let position = 0
  while (position < html.length) {
    const open = lower.indexOf('<', position)
    if (open === -1) break
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4)
      if (close === -1) break
      position = close + 3
      continue
    }
    const name = scannedTagAt(lower, open + 1)
    if (!name) {
      position = open + 1
      continue
    }
    const attributesStart = open + 1 + name.length
    const end = startTagEnd(html, attributesStart)
    if (end === -1) break
    const attrs = tagAttributes(html.slice(attributesStart, end))
    position = end + 1
    if (name === 'link') {
      const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? []
      if (rel.includes('stylesheet')) add('stylesheet', attrs.get('href'))
      continue
    }
    // Script and style bodies are raw text: they end at their own closing tag.
    const close = lower.indexOf(`</${name}`, position)
    const body = html.slice(position, close === -1 ? html.length : close)
    position = close === -1 ? html.length : close + name.length + 2
    if (name === 'style') {
      for (const match of body.matchAll(CSS_IMPORT)) add('stylesheet', match[2])
      continue
    }
    const src = attrs.get('src')
    // A `src` replaces the element's body, so only the URL is loaded.
    if (src !== undefined) {
      add('script', src)
      continue
    }
    const type = attrs.get('type')?.toLowerCase() ?? ''
    if (type === 'module') {
      for (const match of body.matchAll(IMPORT_FROM)) add('script', match[2])
      for (const match of body.matchAll(SIDE_EFFECT_IMPORT)) add('script', match[2])
    }
    // Other types (importmap, JSON, shader source) are data, never run as code.
    if (type === '' || type === 'module' || /javascript|ecmascript/.test(type)) {
      for (const match of body.matchAll(DYNAMIC_IMPORT)) add('script', match[2])
    }
  }
  return loads
}
