import {
  ATX_HEADING_CAPTURE_RE as ATX_HEADING_RE,
  dropTrailingNewline,
  parseFenceSlice,
  stripAtxClosingHashes,
} from './block-patterns.ts'
import {
  type BlockToken,
  listItemContentColumn,
  orderedListMarkerDelimiter,
  parseOrderedListMarker,
  splitTableRow,
  TABLE_SEP_RE,
  tokenizeBlocks,
  unorderedListMarkerChar,
} from './block-tokenizer.ts'
import { escapeMermaidHtml } from './escape.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { type LinkReferenceMap } from './link-references.ts'
import { renderProseBlock } from './render-prose-inline.ts'

export interface RenderBlocksOptions {
  linkRefs?: LinkReferenceMap
}

const BLOCKQUOTE_LINE_RE = /^> ?/

function renderFencedBlock(lang: string, code: string): string {
  if (lang === 'mermaid') {
    const body = escapeMermaidHtml(code.trimEnd())
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`
  }
  const body = highlightFenceCode(code, lang)
  return `<pre><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

function dedentLazyContinuation(text: string, itemFirstLine: string): string {
  const col = listItemContentColumn(itemFirstLine)
  return text
    .split('\n')
    .map((line) => {
      const indent = line.match(/^ */)?.[0].length ?? 0
      return line.slice(Math.min(indent, col))
    })
    .join('\n')
}

/** Strip up to three leading spaces per line (CommonMark paragraph normalization). */
function stripParagraphIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^ {0,3}(?=\S)/, ''))
    .join('\n')
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

function renderListItemContent(
  slice: string,
  listLoose: boolean,
  linkRefs: LinkReferenceMap,
): string {
  const normalized = dropTrailingNewline(slice)
  const firstLine = normalized.split('\n').find((l) => l.trim() !== '') ?? ''
  const paragraphs = splitListItemParagraphs(normalized)
  const rendered = paragraphs.map((p, index) => {
    const lines = p.split('\n')
    const text =
      index === 0
        ? lines
            .map((line, lineIndex) =>
              lineIndex === 0
                ? line.slice(listItemContentColumn(line))
                : dedentLazyContinuation(line, firstLine),
            )
            .join('\n')
        : dedentLazyContinuation(p, firstLine)
    return renderProseBlock(text, linkRefs, listLoose ? 'newline' : 'space')
  })
  if (rendered.length === 0) return ''
  if (listLoose) {
    return rendered.map((p) => `<p>${p}</p>`).join('')
  }
  return rendered.join(' ')
}

function renderParagraph(slice: string, linkRefs: LinkReferenceMap): string {
  const body = stripParagraphIndent(dropTrailingNewline(slice))
  const rendered = renderProseBlock(body, linkRefs)
  if (rendered === '') return ''
  return `<p>${rendered}</p>`
}

function renderAtxHeading(slice: string, linkRefs: LinkReferenceMap): string {
  const line = dropTrailingNewline(slice).split('\n')[0] ?? ''
  const m = line.match(ATX_HEADING_RE)
  if (!m?.[1]) return renderParagraph(slice, linkRefs)
  const level = m[1].length
  const text = stripAtxClosingHashes((m[2] ?? '').trimEnd())
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`
}

function renderSetextHeading(slice: string, linkRefs: LinkReferenceMap): string {
  const lines = dropTrailingNewline(slice).split('\n')
  const text = lines[0] ?? ''
  const underline = lines[1] ?? ''
  const level = underline.trim().startsWith('=') ? 3 : 4
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`
}

function renderTable(slice: string, linkRefs: LinkReferenceMap): string {
  const lines = dropTrailingNewline(slice)
    .split('\n')
    .filter((l) => l.trim() !== '')
  const header = lines[0]
  if (!header) return ''
  const headerCells = splitTableRow(header)
  const body = lines.slice(2).map((row) => splitTableRow(row))
  const thead = `<thead><tr>${headerCells
    .map((c) => `<th>${renderProseBlock(c, linkRefs)}</th>`)
    .join('')}</tr></thead>`
  const tbody = `<tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${renderProseBlock(c, linkRefs)}</td>`).join('')}</tr>`)
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

function renderBlockquote(slice: string, linkRefs: LinkReferenceMap): string {
  const innerSource = stripBlockquoteSource(slice)
  if (innerSource.trim() === '') return ''
  return `<blockquote>${renderBlocksFromSource(innerSource, linkRefs)}</blockquote>`
}

function isOrderedListSlice(slice: string): boolean {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return parseOrderedListMarker(first) !== null
}

function sliceUnorderedMarkerChar(slice: string): '-' | '*' | '+' | null {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return unorderedListMarkerChar(first)
}

function orderedListStart(slice: string): number {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return parseOrderedListMarker(first) ?? 1
}

function orderedListDelimiter(slice: string): '.' | ')' | null {
  const first = slice.split('\n').find((l) => l.trim() !== '') ?? ''
  return orderedListMarkerDelimiter(first)
}

function collectListGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
  linkRefs: LinkReferenceMap,
): { html: string; next: number } {
  const firstToken = tokens[start]
  const firstSlice = firstToken ? source.slice(firstToken.start, firstToken.end) : ''
  const ordered = isOrderedListSlice(firstSlice)
  const markerChar = ordered ? null : sliceUnorderedMarkerChar(firstSlice)
  const orderedDelimiter = ordered ? orderedListDelimiter(firstSlice) : null
  const listStart = ordered ? orderedListStart(firstSlice) : 1
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
    if (ordered) {
      if (orderedListDelimiter(slice) !== orderedDelimiter) break
    } else {
      const itemMarker = sliceUnorderedMarkerChar(slice)
      if (itemMarker !== markerChar) break
    }
    if (splitListItemParagraphs(dropTrailingNewline(slice)).length > 1) {
      loose = true
    }
    itemSlices.push(slice)
    i++
  }
  const items = itemSlices.map(
    (slice) => `<li>${renderListItemContent(slice, loose, linkRefs)}</li>`,
  )
  if (ordered) {
    const startAttr = listStart === 1 ? '' : ` start="${String(listStart)}"`
    return { html: `<ol${startAttr}>${items.join('')}</ol>`, next: i }
  }
  return { html: `<ul>${items.join('')}</ul>`, next: i }
}

function collectBlockquoteGroup(
  source: string,
  tokens: BlockToken[],
  start: number,
  linkRefs: LinkReferenceMap,
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
    html: `<blockquote>${renderBlocksFromSource(innerSource, linkRefs)}</blockquote>`,
    next: i,
  }
}

function renderSingleBlock(source: string, token: BlockToken, linkRefs: LinkReferenceMap): string {
  const slice = source.slice(token.start, token.end)
  switch (token.kind) {
    case 'fence': {
      const { lang, code } = parseFenceSlice(slice)
      return renderFencedBlock(lang, code)
    }
    case 'atx_heading':
      return renderAtxHeading(slice, linkRefs)
    case 'setext_heading':
      return renderSetextHeading(slice, linkRefs)
    case 'thematic_break':
      return '<hr>'
    case 'table':
      return renderTable(slice, linkRefs)
    case 'blockquote':
      return renderBlockquote(slice, linkRefs)
    case 'list_item':
      return `<li>${renderListItemContent(slice, false, linkRefs)}</li>`
    case 'link_ref_def':
    case 'blank':
      return ''
    case 'paragraph':
      return renderParagraph(slice, linkRefs)
    default:
      return renderParagraph(slice, linkRefs)
  }
}

/** Render tokenized block-level markdown to HTML (#475 phase 2). */
export function renderBlocks(
  source: string,
  tokens: BlockToken[],
  options: RenderBlocksOptions = {},
): string {
  const linkRefs = options.linkRefs ?? new Map()
  const parts: string[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) break
    if (token.kind === 'blank' || token.kind === 'link_ref_def') {
      i++
      continue
    }
    if (token.kind === 'list_item') {
      const group = collectListGroup(source, tokens, i, linkRefs)
      if (group.html) parts.push(group.html)
      i = group.next
      continue
    }
    if (token.kind === 'blockquote') {
      const group = collectBlockquoteGroup(source, tokens, i, linkRefs)
      if (group.html) parts.push(group.html)
      i = group.next
      continue
    }
    const html = renderSingleBlock(source, token, linkRefs)
    if (html) parts.push(html)
    i++
  }
  return parts.join('\n')
}

/** Tokenize and render a markdown fragment (used for blockquote recursion). */
export function renderBlocksFromSource(
  source: string,
  linkRefs: LinkReferenceMap = new Map(),
): string {
  return renderBlocks(source, tokenizeBlocks(source), { linkRefs })
}

/** Whether a line is a GFM table separator (exported for tests that need it). */
export function isTableSeparatorLine(line: string): boolean {
  return TABLE_SEP_RE.test(line)
}
