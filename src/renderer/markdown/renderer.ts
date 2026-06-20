export function renderMarkdown(raw: string): string {
  // Sanitise first — strip any literal HTML tags from model output
  let s = raw.replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Fenced code blocks
  s = s.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code class="lang-${lang || 'text'}">${code.trimEnd()}</code></pre>`,
  )

  // Tables (GFM). Parse only outside <pre> blocks so code containing pipes is
  // left alone. Cell contents keep their markdown — inline formatting runs after.
  s = s
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((seg, i) => (i % 2 === 1 ? seg : parseTables(seg)))
    .join('')

  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // Italic — skip underscores/asterisks inside inline code (e.g. `search_codebase`)
  s = applyOutsideCode(s, /_([^_\n]+)_/g, '<em>$1</em>')
  s = applyOutsideCode(s, /(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')

  // Headings (h3/h4 — h1/h2 are too large in a narrow pane)
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  s = s.replace(/^## (.+)$/gm, '<h4>$1</h4>')
  s = s.replace(/^# (.+)$/gm, '<h4>$1</h4>')

  // Thematic breaks (---, ***, ___) — isolate as block elements before list/paragraph passes
  s = s.replace(/^ {0,3}(-{3,}|\*{3,}|_{3,}) *$/gm, '\n\n<hr>\n\n')

  // Unordered list items (-, *, +)
  s = s.replace(/^(?:[-*+] )(.+)$/gm, '<li>$1</li>')
  s = s.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)

  // Paragraphs (blank-line separated)
  s = s
    .split(/\n\n+/)
    .map((block) => wrapParagraphBlock(block))
    .filter((block) => block !== '')
    .join('\n')

  return s
}

function applyOutsideCode(text: string, pattern: RegExp, replacement: string): string {
  return text
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(pattern, replacement)))
    .join('')
}

const BLOCK_START_RE = /^<(pre|ul|ol|h[34]|table|hr)/
const BLOCK_CLOSE_RE = /<\/(pre|ul|ol|h[34]|table|hr)>$/
const CONTAINS_BLOCK_RE = /<(ul|ol|h[34]|pre|table|hr)[\s>]/

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
