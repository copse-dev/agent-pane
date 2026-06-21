const FENCE_RE = /```(\w*)\n([\s\S]*?)```/g
const FENCED_BLOCK_SPLIT_RE =
  /(<pre>[\s\S]*?<\/pre>|<div class="mermaid-diagram[^>]*>[\s\S]*?<\/div>)/

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Mermaid reads arrow syntax (`-->`); only escape what can break out of `<pre>`. */
function escapeMermaidHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function renderFencedBlock(lang: string, code: string): string {
  if (lang === 'mermaid') {
    const body = escapeMermaidHtml(code.trimEnd())
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`
  }
  const body = escapeHtml(code.trim())
  return `<pre><code class="lang-${lang || 'text'}">${body}</code></pre>`
}

function mapOutsideFencedHtml(html: string, transform: (segment: string) => string): string {
  return html
    .split(FENCED_BLOCK_SPLIT_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : transform(seg)))
    .join('')
}

/** Extract fenced blocks before prose escaping so code and diagram syntax stay intact. */
function extractFencedBlocks(raw: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  const text = raw.replace(FENCE_RE, (_, lang: string, code: string) => {
    const idx = blocks.length
    blocks.push(renderFencedBlock(lang, code))
    return `\x00FENCE${idx}\x00`
  })
  return { text, blocks }
}

function restoreFencedBlocks(text: string, blocks: string[]): string {
  return text.replace(/\x00FENCE(\d+)\x00/g, (_, i: string) => blocks[Number(i)] ?? '')
}

export function renderMarkdown(raw: string): string {
  const { text: withPlaceholders, blocks } = extractFencedBlocks(raw)
  let s = escapeHtml(withPlaceholders)
  s = restoreFencedBlocks(s, blocks)

  // Tables + inline/block markdown only outside fenced code and mermaid diagrams.
  s = mapOutsideFencedHtml(s, (seg) => parseTables(seg))
  s = mapOutsideFencedHtml(s, (seg) => {
    let t = seg
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = applyOutsideCode(t, /_([^_\n]+)_/g, '<em>$1</em>')
    t = applyOutsideCode(t, /(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    t = t.replace(/^## (.+)$/gm, '<h4>$1</h4>')
    t = t.replace(/^# (.+)$/gm, '<h4>$1</h4>')
    t = t.replace(/^ {0,3}(-{3,}|\*{3,}|_{3,}) *$/gm, '\n\n<hr>\n\n')
    t = t.replace(/^(?:[-*+] )(.+)$/gm, '<li>$1</li>')
    t = t.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    return t
  })

  s = mapOutsideFencedHtml(s, (seg) => wrapProseBlocks(seg))

  return s
}

function applyOutsideCode(text: string, pattern: RegExp, replacement: string): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(pattern, replacement)))
    .join('')
}

const BLOCK_START_RE = /^<(pre|ul|ol|h[34]|table|hr|div class="mermaid-diagram\b)/
const BLOCK_CLOSE_RE = /<\/(pre|ul|ol|h[34]|table|hr|div)>$/
const CONTAINS_BLOCK_RE = /<(ul|ol|h[34]|pre|table|hr|div class="mermaid-diagram\b)[\s>]/
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
    const block = rawBlocks[i]!
    const lines = block.split('\n').map((l) => l.trim())
    if (lines.length > 1 && lines.every(isOrderedItemLine)) {
      out.push(`<ol>${lines.map((l) => `<li>${orderedItemContent(l)}</li>`).join('')}</ol>`)
      i++
      continue
    }
    if (isOrderedItemLine(block) && !block.includes('\n')) {
      const items: string[] = []
      while (i < rawBlocks.length) {
        const b = rawBlocks[i]!
        if (!isOrderedItemLine(b) || b.includes('\n')) break
        let content = orderedItemContent(b)
        i++
        while (i < rawBlocks.length) {
          const next = rawBlocks[i]!
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
    return splitBlockElements(block)
      .map((part) => wrapParagraphBlock(part))
      .join('\n')
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
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
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
