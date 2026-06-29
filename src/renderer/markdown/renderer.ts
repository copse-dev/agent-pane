import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { escapeHtml, escapeMermaidHtml } from './escape.ts'

export { escapeHtml } from './escape.ts'

const FENCE_RE = /```(\w*)\n([\s\S]*?)```/g
const FENCED_BLOCK_SPLIT_RE =
  /(<pre>[\s\S]*?<\/pre>|<div class="mermaid-diagram[^>]*>[\s\S]*?<\/div>)/

function renderFencedBlock(lang: string, code: string): string {
  if (lang === 'mermaid') {
    const body = escapeMermaidHtml(code.trimEnd())
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`
  }
  const body = highlightFenceCode(code, lang)
  return `<pre><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

function mapOutsideFencedHtml(html: string, transform: (segment: string) => string): string {
  return html
    .split(FENCED_BLOCK_SPLIT_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : transform(seg)))
    .join('')
}

// Like FENCED_BLOCK_SPLIT_RE, but also shields already-rendered tables. Table
// cells have their inline markup applied per-cell in parseTables; running the
// global inline pass over the finished <table> again would re-pair `**` across
// cells (the bug in #469), so the inline pass skips table regions entirely.
const FENCED_OR_TABLE_SPLIT_RE =
  /(<pre>[\s\S]*?<\/pre>|<div class="mermaid-diagram[^>]*>[\s\S]*?<\/div>|<table>[\s\S]*?<\/table>)/

function mapOutsideFencedOrTableHtml(html: string, transform: (segment: string) => string): string {
  return html
    .split(FENCED_OR_TABLE_SPLIT_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : transform(seg)))
    .join('')
}

/** Extract fenced blocks before prose escaping so code and diagram syntax stay intact. */
function extractFencedBlocks(raw: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  const text = raw.replace(FENCE_RE, (_, lang: string, code: string) => {
    const idx = blocks.length
    blocks.push(renderFencedBlock(lang, code))
    return `\x00FENCE${String(idx)}\x00`
  })
  return { text, blocks }
}

function restoreFencedBlocks(text: string, blocks: string[]): string {
  return text.replace(/\x00FENCE(\d+)\x00/g, (_, i: string) => blocks[Number(i)] ?? '')
}

/** GitHub PR templates often include HTML comments; strip them from prose only. */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

export function renderMarkdown(raw: string): string {
  const { text: withPlaceholders, blocks } = extractFencedBlocks(raw)
  let s = escapeHtml(stripHtmlComments(withPlaceholders))
  s = restoreFencedBlocks(s, blocks)
  s = mapOutsideFencedHtml(s, (seg) => renderArtifactImageTags(seg))

  // Tables first: parseTables renders each cell's inline markup in isolation
  // (renderInlineSpans), then the finished <table> is shielded from the pass
  // below via mapOutsideFencedOrTableHtml so emphasis can't pair across cells.
  s = mapOutsideFencedHtml(s, (seg) => parseTables(seg))
  s = mapOutsideFencedOrTableHtml(s, (seg) => {
    let t = seg
    // Thematic break: a line of 3+ of the same -, *, or _ marker, optionally
    // separated by spaces/tabs. Detect before the inline `*`/`_` passes so a
    // spaced break like `* * *` / `_ _ _` is not chewed into stray <em> spans.
    t = t.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '\n\n<hr>\n\n')
    t = renderInlineSpans(t)
    // ATX headings: # → h1 through ###### → h6
    t = t.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    t = t.replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    t = t.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    t = t.replace(/^## (.+)$/gm, '<h2>$1</h2>')
    t = t.replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Setext headings (=== → h3, --- → h4)
    t = t.replace(/^(.+)\n={3,}$/gm, '<h3>$1</h3>')
    t = t.replace(/^(.+)\n-{3,}$/gm, '<h4>$1</h4>')
    t = t.replace(/^(?:[-*+] )(.+)$/gm, '<li>$1</li>')
    t = wrapLooseListItems(t)
    return t
  })

  s = mapOutsideFencedHtml(s, (seg) => wrapProseBlocks(seg))

  return s
}

/**
 * CommonMark code spans: a run of N backticks opens a span that closes at the
 * next run of exactly N backticks. Interior line endings collapse to spaces, and
 * a single leading+trailing space is stripped when both are present and the
 * content is not all spaces. Runs of a different length stay literal content, so
 * `` `` foo ` bar `` `` and ``code`` work — unlike a naive single-backtick regex.
 * Input is already HTML-escaped (backticks survive escaping), so content is safe.
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

/** Group consecutive `<li>` blocks (including blank-line gaps) into a tight `<ul>`. */
function wrapLooseListItems(text: string): string {
  return text.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (match) => {
    const items = match.match(/<li>[\s\S]*?<\/li>/g) ?? []
    return `<ul>${items.join('')}</ul>`
  })
}

/**
 * Inline span markup (code, links, bold, italic) for a single line/segment of
 * already-escaped text. Shared by the main render pass and per-cell table
 * rendering so a table cell gets the same emphasis treatment as prose without
 * any `**` pairing leaking across cell boundaries. Block-level constructs
 * (headings, lists, thematic breaks) are intentionally not handled here — they
 * only apply to the main pass, never inside a table cell.
 */
function renderInlineSpans(t: string): string {
  t = renderInlineCode(t)
  t = renderMarkdownLinks(t)
  t = renderBareHttpLinks(t)
  // Bold around inline HTML first (`**` + text + <code>/<a>/<img> + text + `**`);
  // then prose bold outside code spans. A single [^*]+ pass breaks on globs like
  // src/**/*.test.ts inside <code> and can pair ** across spans, leaving stray
  // markers (e.g. MCP host**:).
  t = t.replace(/\*\*(<code>[\s\S]*?<\/code>)\*\*/g, '<strong>$1</strong>')
  t = renderBoldAroundInlineHtml(t)
  t = renderItalicAroundInlineHtml(t)
  t = applyOutsideInlineHtml(t, /\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  t = applyOutsideInlineHtml(t, /_([^_\n]+)_/g, '<em>$1</em>')
  t = applyOutsideInlineHtml(t, /(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  return t
}

function applyOutsideInlineHtml(text: string, pattern: RegExp, replacement: string): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(pattern, replacement)))
    .join('')
}

function renderBoldAroundInlineHtml(text: string): string {
  // The opening `**` must be left-flanking (followed by a non-space): a `**`
  // followed by whitespace can only *close* emphasis, never open it. Without
  // this guard an odd `**` count like `**Label** … <code>…</code>).**` pairs the
  // label's closing `**` with the stray trailing one across the code span,
  // bolding the wrong half and leaving `**Label` literal (#streaming-bold).
  return text.replace(
    /\*\*(?=\S)([^*\n]*<(?:code|a|img)\b[\s\S]*?(?:<\/(?:code|a)>|>)[^*\n]*)\*\*/g,
    '<strong>$1</strong>',
  )
}

function renderItalicAroundInlineHtml(text: string): string {
  return text
    .replace(/_([^_\n]*<(?:a|img)\b[\s\S]*?(?:<\/a>|>)[^_\n]*)_/g, '<em>$1</em>')
    .replace(/(?<!\*)\*([^*\n]*<(?:a|img)\b[\s\S]*?(?:<\/a>|>)[^*\n]*)\*(?!\*)/g, '<em>$1</em>')
}

/** Only allow safe URL schemes in rendered links. */
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

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const decodedTag = decodeEscapedHref(tag)
  for (const match of decodedTag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]
    if (name === undefined) continue
    attrs[name.toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return attrs
}

function artifactImageSource(rawSrc: string): { path: string; agentId?: string } | null {
  if (rawSrc.startsWith('/opt/cursor/artifacts/')) {
    return { path: `artifacts/${rawSrc.slice('/opt/cursor/artifacts/'.length)}` }
  }
  if (rawSrc.startsWith('artifacts/')) return { path: rawSrc }

  let url: URL
  try {
    url = new URL(rawSrc)
  } catch {
    return null
  }
  const match = url.pathname.match(/^\/v1\/agents\/([^/]+)\/artifacts\/download$/)
  const path = url.searchParams.get('path')
  if (!match?.[1] || !path?.startsWith('artifacts/')) return null
  return { agentId: decodeURIComponent(match[1]), path }
}

function renderArtifactImageTags(text: string): string {
  return text.replace(/&lt;img\b[\s\S]*?\/?&gt;/gi, (tag) => {
    const attrs = parseHtmlAttributes(tag)
    const artifact = attrs['src'] ? artifactImageSource(attrs['src']) : null
    if (!artifact) return tag
    const alt = attrs['alt'] ?? 'Remote agent artifact'
    const agent = artifact.agentId
      ? ` data-remote-artifact-agent-id="${escapeHtml(artifact.agentId)}"`
      : ''
    return `<img class="remote-artifact-image" data-remote-artifact-path="${escapeHtml(
      artifact.path,
    )}"${agent} alt="${escapeHtml(alt)}" loading="lazy">`
  })
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

const BLOCK_START_RE = /^<(pre|ul|ol|h[1-6]|table|hr|img|div class="mermaid-diagram\b)/
const BLOCK_CLOSE_RE = /<\/(pre|ul|ol|h[1-6]|table|hr|div)>$/
const CONTAINS_BLOCK_RE = /<(ul|ol|h[1-6]|pre|table|hr|img|div class="mermaid-diagram\b)[\s>]/
const ORDERED_ITEM_RE = /^(\d+)\. (.+)$/

function isOrderedItemLine(line: string): boolean {
  return ORDERED_ITEM_RE.test(line.trim())
}

function orderedItemContent(line: string): string {
  const m = line.trim().match(ORDERED_ITEM_RE)
  return m?.[2] ?? line
}

/** Group `1. item` blocks and their following prose into a single `<ol>`. */
function wrapProseBlocks(seg: string): string {
  const rawBlocks = seg
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b !== '')
  const out: string[] = []
  let i = 0
  while (i < rawBlocks.length) {
    const block = rawBlocks[i]
    if (block === undefined) break
    const lines = block.split('\n').map((l) => l.trim())
    if (lines.length > 1 && lines.every(isOrderedItemLine)) {
      out.push(`<ol>${lines.map((l) => `<li>${orderedItemContent(l)}</li>`).join('')}</ol>`)
      i++
      continue
    }
    if (isOrderedItemLine(block) && !block.includes('\n')) {
      const items: string[] = []
      while (i < rawBlocks.length) {
        const b = rawBlocks[i]
        if (b === undefined || !isOrderedItemLine(b) || b.includes('\n')) break
        let content = orderedItemContent(b)
        i++
        while (i < rawBlocks.length) {
          const next = rawBlocks[i]
          if (next === undefined) break
          const trimmed = next.trim()
          if (isOrderedItemLine(trimmed)) break
          if (BLOCK_START_RE.test(trimmed)) break
          if (CONTAINS_BLOCK_RE.test(trimmed)) break
          content += `<br><br>${next}`
          i++
        }
        items.push(`<li>${content}</li>`)
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    out.push(wrapParagraphBlock(block))
    i++
  }
  return out.join('\n')
}

function splitBlockElements(block: string): string[] {
  const lines = block.split('\n')
  const parts: string[] = []
  let current: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const prev = current[current.length - 1]?.trim() ?? ''
    if (BLOCK_START_RE.test(trimmed) && current.length > 0) {
      parts.push(current.join('\n'))
      current = [line]
    } else if (prev && BLOCK_CLOSE_RE.test(prev) && trimmed && !BLOCK_START_RE.test(trimmed)) {
      parts.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) parts.push(current.join('\n'))
  return parts
}

function wrapParagraphBlock(block: string): string {
  const trimmed = block.trim()
  if (trimmed === '') return ''
  if (BLOCK_START_RE.test(trimmed)) return block
  if (CONTAINS_BLOCK_RE.test(trimmed)) {
    const parts = splitBlockElements(block)
    if (parts.length === 1 && parts[0] === block) {
      return `<p>${block.replace(/\n/g, '<br>')}</p>`
    }
    return parts.map((part) => wrapParagraphBlock(part)).join('\n')
  }
  return `<p>${block.replace(/\n/g, '<br>')}</p>`
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

// Detects GFM tables: a header row, a separator row of dashes, then body rows.
// Leading/trailing pipes are optional.
function parseTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  const sepRe = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const sep = lines[i + 1]
    if (header && sep && header.includes('|') && sepRe.test(sep)) {
      const headerCells = splitRow(header)
      const body: string[][] = []
      let j = i + 2
      while (j < lines.length) {
        const row = lines[j]
        if (!row || !row.includes('|') || row.trim() === '') break
        body.push(splitRow(row))
        j++
      }
      // Render each cell's inline markup in isolation so emphasis (`**bold**`)
      // is scoped to the cell and never pairs `**` across adjacent cells (#469).
      const thead = `<thead><tr>${headerCells
        .map((c) => `<th>${renderInlineSpans(c)}</th>`)
        .join('')}</tr></thead>`
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInlineSpans(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
      out.push(`<table>${thead}${tbody}</table>`)
      i = j
    } else {
      out.push(header ?? '')
      i++
    }
  }
  return out.join('\n')
}
