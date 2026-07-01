import { renderArtifactImageTags } from './artifact-images.ts'
import { type BlockToken, splitTableRow, TABLE_SEP_RE, tokenizeBlocks } from './block-tokenizer.ts'
import { escapeHtml, escapeMermaidHtml } from './escape.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { renderInlineSpans } from './inline-spans.ts'

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\s*$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?: (.*)|$)/
const ORDERED_LIST_ITEM_RE = /^ {0,3}\d+\.\s/
const BLOCKQUOTE_LINE_RE = /^> ?/

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/** Drop the block-terminating newline token slices include. */
function normalizeBlockSlice(slice: string): string {
  return slice.endsWith('\n') ? slice.slice(0, -1) : slice
}

function renderProseBlock(text: string): string {
  const body = stripHtmlComments(text)
  if (body.trim() === '') return ''
  const rendered = renderInlineSpans(renderArtifactImageTags(escapeHtml(body)))
  return rendered.replace(/\n/g, '<br>')
}

function renderFencedBlock(lang: string, code: string): string {
  if (lang === 'mermaid') {
    const body = escapeMermaidHtml(code.trimEnd())
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`
  }
  const body = highlightFenceCode(code, lang)
  return `<pre><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

function parseFence(slice: string): { lang: string; code: string } {
  const lines = slice.split('\n')
  const open = lines[0] ?? ''
  const openMatch = open.match(FENCE_OPEN_RE)
  const marker = openMatch?.[1] ?? '```'
  const lang = (openMatch?.[2] ?? '').trim()
  let closeIndex = lines.length - 1
  while (closeIndex > 0) {
    const line = lines[closeIndex] ?? ''
    const closeMatch = line.match(FENCE_CLOSE_RE)
    if (
      closeMatch?.[1] &&
      closeMatch[1][0] === marker[0] &&
      closeMatch[1].length >= marker.length
    ) {
      break
    }
    closeIndex--
  }
  const code = lines.slice(1, closeIndex).join('\n')
  return { lang, code }
}

function stripListMarker(line: string): string {
  return line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s/, '')
}

function stripBlockquoteLine(line: string): string {
  return line.replace(BLOCKQUOTE_LINE_RE, '')
}

function splitListItemParagraphs(text: string): string[] {
  const parts: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) parts.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) parts.push(current.join('\n'))
  return parts
}

function renderListItemContent(slice: string, listLoose: boolean): string {
  const paragraphs = splitListItemParagraphs(normalizeBlockSlice(slice))
  const rendered = paragraphs
    .map((p, index) => {
      const text = index === 0 ? stripListMarker(p) : p
      return renderProseBlock(text)
    })
    .filter((p) => p !== '')
  if (listLoose) {
    return rendered.map((p) => `<p>${p}</p>`).join('')
  }
  return rendered.join('<br><br>')
}

function renderParagraph(slice: string): string {
  const body = normalizeBlockSlice(slice)
  const rendered = renderProseBlock(body)
  if (rendered === '') return ''
  return `<p>${rendered}</p>`
}

function renderAtxHeading(slice: string): string {
  const line = normalizeBlockSlice(slice).split('\n')[0] ?? ''
  const m = line.match(ATX_HEADING_RE)
  if (!m?.[1]) return renderParagraph(slice)
  const level = m[1].length
  const text = (m[2] ?? '').trimEnd()
  return `<h${String(level)}>${renderProseBlock(text)}</h${String(level)}>`
}

function renderSetextHeading(slice: string): string {
  const lines = normalizeBlockSlice(slice).split('\n')
  const text = lines[0] ?? ''
  const underline = lines[1] ?? ''
  const level = underline.trim().startsWith('=') ? 3 : 4
  return `<h${String(level)}>${renderProseBlock(text)}</h${String(level)}>`
}

function renderTable(slice: string): string {
  const lines = normalizeBlockSlice(slice)
    .split('\n')
    .filter((l) => l.trim() !== '')
  const header = lines[0]
  if (!header) return ''
  const headerCells = splitTableRow(header)
  const body = lines.slice(2).map((row) => splitTableRow(row))
  const thead = `<thead><tr>${headerCells
    .map((c) => `<th>${renderProseBlock(c)}</th>`)
    .join('')}</tr></thead>`
  const tbody = `<tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${renderProseBlock(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

function stripBlockquoteSource(slice: string): string {
  return slice
    .split('\n')
    .map((l) => stripBlockquoteLine(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

function renderBlockquote(slice: string): string {
  const innerSource = stripBlockquoteSource(slice)
  if (innerSource.trim() === '') return ''
  return `<blockquote>${renderBlocksFromSource(innerSource)}</blockquote>`
}

function isOrderedListSlice(slice: string): boolean {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return ORDERED_LIST_ITEM_RE.test(first)
}

function collectListGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
): { html: string; next: number } {
  const firstToken = tokens[start]
  const firstSlice = firstToken ? source.slice(firstToken.start, firstToken.end) : ''
  const ordered = isOrderedListSlice(firstSlice)
  const itemSlices: string[] = []
  let loose = false
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      const next = tokens[i + 1]
      if (next?.kind === 'list_item') {
        loose = true
        i++
        continue
      }
      break
    }
    if (token.kind !== 'list_item') break
    const slice = source.slice(token.start, token.end)
    if (isOrderedListSlice(slice) !== ordered) break
    if (splitListItemParagraphs(normalizeBlockSlice(slice)).length > 1) {
      loose = true
    }
    itemSlices.push(slice)
    i++
  }
  const items = itemSlices.map((slice) => `<li>${renderListItemContent(slice, loose)}</li>`)
  const tag = ordered ? 'ol' : 'ul'
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i }
}

function collectBlockquoteGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
): { html: string; next: number } {
  const parts: string[] = []
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      const next = tokens[i + 1]
      if (next?.kind === 'blockquote') {
        i++
        continue
      }
      break
    }
    if (token.kind !== 'blockquote') break
    parts.push(stripBlockquoteSource(source.slice(token.start, token.end)))
    i++
  }
  const innerSource = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
  if (innerSource.trim() === '') return { html: '', next: i }
  return {
    html: `<blockquote>${renderBlocksFromSource(innerSource)}</blockquote>`,
    next: i,
  }
}

function renderSingleBlock(source: string, token: BlockToken): string {
  const slice = source.slice(token.start, token.end)
  switch (token.kind) {
    case 'fence': {
      const { lang, code } = parseFence(slice)
      return renderFencedBlock(lang, code)
    }
    case 'atx_heading':
      return renderAtxHeading(slice)
    case 'setext_heading':
      return renderSetextHeading(slice)
    case 'thematic_break':
      return '<hr>'
    case 'table':
      return renderTable(slice)
    case 'blockquote':
      return renderBlockquote(slice)
    case 'list_item':
      return `<li>${renderListItemContent(slice, false)}</li>`
    case 'paragraph':
      return renderParagraph(slice)
    case 'blank':
      return ''
    default:
      return renderParagraph(slice)
  }
}

/** Render tokenized block-level markdown to HTML (#475 phase 2). */
export function renderBlocks(source: string, tokens: BlockToken[]): string {
  const parts: string[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank') {
      i++
      continue
    }
    if (token.kind === 'list_item') {
      const group = collectListGroup(source, tokens, i)
      if (group.html) parts.push(group.html)
      i = group.next
      continue
    }
    if (token.kind === 'blockquote') {
      const group = collectBlockquoteGroup(source, tokens, i)
      if (group.html) parts.push(group.html)
      i = group.next
      continue
    }
    const html = renderSingleBlock(source, token)
    if (html) parts.push(html)
    i++
  }
  return parts.join('\n')
}

/** Tokenize and render a markdown fragment (used for blockquote recursion). */
export function renderBlocksFromSource(source: string): string {
  return renderBlocks(source, tokenizeBlocks(source))
}

/** Whether a line is a GFM table separator (exported for tests that need it). */
export function isTableSeparatorLine(line: string): boolean {
  return TABLE_SEP_RE.test(line)
}
