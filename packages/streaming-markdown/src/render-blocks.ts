import {
  ATX_HEADING_CAPTURE_RE as ATX_HEADING_RE,
  dropTrailingNewline,
  parseFenceSlice,
  stripAtxClosingHashes,
  stripFourColumnIndent,
} from './block-patterns.ts'
import {
  type BlockToken,
  isAmbiguousBlockLine,
  listItemContentColumn,
  orderedListMarkerDelimiter,
  parseOrderedListMarker,
  splitTableRow,
  TABLE_SEP_RE,
  tokenizeBlocks,
  unorderedListMarkerChar,
} from './block-tokenizer.ts'
import { escapeHtml, escapeMermaidHtml } from './escape.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { dedentBlock, isIndentedHtmlBlock } from './indented-html.ts'
import { type LinkReferenceMap } from './link-references.ts'
import { renderProseBlock } from './render-prose-inline.ts'

export interface RenderBlocksOptions {
  linkRefs?: LinkReferenceMap
  /** Tight list items render top-level paragraphs bare (no <p>, space soft breaks). */
  tightParagraphs?: boolean
  /**
   * Reclassify top-level `indented_code` blocks that are really raw HTML as prose
   * (#616). Only the top-level `renderMarkdown` entry sets this; recursive
   * list/blockquote rendering leaves nested indented code as CommonMark code.
   */
  htmlFromIndent?: boolean
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

function renderIndentedCode(slice: string): string {
  const lines = dropTrailingNewline(slice).split('\n')
  while (lines.length && (lines.at(-1) ?? '').trim() === '') lines.pop()
  const code = lines.map((l) => stripFourColumnIndent(l)).join('\n')
  if (code.trim() === '') return ''
  return `<pre><code>${escapeHtml(code)}\n</code></pre>`
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

/** A GFM task-list checkbox at the very start of an item's content (#614). */
const TASK_LIST_MARKER_RE = /^\[([ xX])\](?=\s|$)/

interface TaskListMarker {
  checked: boolean
  /** Item content with the `[ ]`/`[x]` marker (and one following space) removed. */
  rest: string
}

/** Match a leading task-list checkbox on the first content line of an item. */
function parseTaskListMarker(inner: string): TaskListMarker | null {
  const m = TASK_LIST_MARKER_RE.exec(inner)
  if (!m) return null
  const checked = (m[1] ?? '') !== ' '
  let rest = inner.slice(m[0].length)
  // Drop a single separating space so `[ ] foo` → `foo`; keep further indent.
  if (rest.startsWith(' ')) rest = rest.slice(1)
  return { checked, rest }
}

function taskCheckboxHtml(checked: boolean): string {
  return `<input type="checkbox" disabled${checked ? ' checked' : ''}>`
}

interface RenderedListItem {
  html: string
  task: TaskListMarker | null
}

function renderListItemContent(
  slice: string,
  listLoose: boolean,
  linkRefs: LinkReferenceMap,
): RenderedListItem {
  const normalized = dropTrailingNewline(slice)
  const lines = normalized.split('\n')
  const first = lines.find((l) => l.trim() !== '') ?? ''
  const col = listItemContentColumn(first)
  const dedented: string[] = []
  lines.forEach((line, index) => {
    if (index === 0) {
      dedented.push(line.slice(Math.min(col, line.length)))
      return
    }
    const indent = line.match(/^ */)?.[0].length ?? 0
    if (indent >= col) {
      dedented.push(line.slice(col))
      return
    }
    const stripped = line.slice(indent)
    const prev = dedented.at(-1)
    // A lazy (under-indented) continuation can only extend the open paragraph;
    // it can never open a new block inside the item (CommonMark #312).
    if (
      stripped.trim() !== '' &&
      prev !== undefined &&
      prev.trim() !== '' &&
      isAmbiguousBlockLine(stripped)
    ) {
      dedented[dedented.length - 1] = `${prev} ${stripped}`
      return
    }
    dedented.push(stripped)
  })
  let inner = dedented.join('\n')
  if (inner.trim() === '') return { html: '', task: null }
  // A checkbox marker only counts on the item's first content line; strip it
  // before recursive tokenization so the box never lands inside prose.
  const task = parseTaskListMarker(inner)
  if (task) inner = task.rest
  // Item content is a block fragment in its own right: recursive tokenization
  // handles nested lists, fences, blockquotes, and indented code (#595).
  const html = renderBlocks(inner, tokenizeBlocks(inner), {
    linkRefs,
    tightParagraphs: !listLoose,
  })
  return { html, task }
}

/** Wrap rendered item content in an `<li>`, prepending a checkbox for task items. */
function renderListItem(item: RenderedListItem): string {
  if (item.task) {
    const box = taskCheckboxHtml(item.task.checked)
    const gap = item.html === '' ? '' : ' '
    return `<li class="task-list-item">${box}${gap}${item.html}</li>`
  }
  return `<li>${item.html}</li>`
}

function renderParagraph(slice: string, linkRefs: LinkReferenceMap, tight = false): string {
  const body = stripParagraphIndent(dropTrailingNewline(slice))
  const rendered = renderProseBlock(body, linkRefs, tight ? 'space' : 'newline')
  if (rendered === '') return ''
  return tight ? rendered : `<p>${rendered}</p>`
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
  const level = underline.trim().startsWith('=') ? 1 : 2
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
  const items = itemSlices.map((slice) => renderListItemContent(slice, loose, linkRefs))
  const itemsHtml = items.map(renderListItem).join('')
  if (ordered) {
    const startAttr = listStart === 1 ? '' : ` start="${String(listStart)}"`
    return { html: `<ol${startAttr}>${itemsHtml}</ol>`, next: i }
  }
  // GitHub flags lists that hold checkboxes so their bullets can be hidden.
  const listClass = items.some((it) => it.task) ? ' class="contains-task-list"' : ''
  return { html: `<ul${listClass}>${itemsHtml}</ul>`, next: i }
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

function renderSingleBlock(
  source: string,
  token: BlockToken,
  linkRefs: LinkReferenceMap,
  tightParagraphs: boolean,
  htmlFromIndent: boolean,
): string {
  const slice = source.slice(token.start, token.end)
  switch (token.kind) {
    case 'indented_code':
      // A top-level indented block that is really raw HTML follows the raw-HTML
      // policy (escaped/benign prose), not a <pre><code> dump (#616).
      if (htmlFromIndent && isIndentedHtmlBlock(dropTrailingNewline(slice))) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false)
      }
      return renderIndentedCode(slice)
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
      return renderListItem(renderListItemContent(slice, false, linkRefs))
    case 'link_ref_def':
    case 'blank':
      return ''
    case 'paragraph':
      return renderParagraph(slice, linkRefs, tightParagraphs)
    default:
      return renderParagraph(slice, linkRefs, tightParagraphs)
  }
}

/** Render tokenized block-level markdown to HTML (#475 phase 2). */
export function renderBlocks(
  source: string,
  tokens: BlockToken[],
  options: RenderBlocksOptions = {},
): string {
  const linkRefs = options.linkRefs ?? new Map()
  const tightParagraphs = options.tightParagraphs ?? false
  const htmlFromIndent = options.htmlFromIndent ?? false
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
    const html = renderSingleBlock(source, token, linkRefs, tightParagraphs, htmlFromIndent)
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
