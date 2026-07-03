/**
 * Regression: Terms of Service fixture — dense prose, nbsp metadata, numbered lists,
 * fee table, blockquotes, and fenced address block. Catches partial table renders
 * (raw | cell | text in inline pending) while streaming.
 */
import '../tests/setup-dom-jsdom.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

const TERMS_PATH = resolve(
  process.cwd(),
  'packages/streaming-markdown/tests/fixtures/terms-of-service-streaming.md',
)
const TERMS = readFileSync(TERMS_PATH, 'utf8')

const SUBSCRIPTION_TABLE_MARKER =
  TERMS.split('\n').find((line) => line.trimStart().startsWith('| Feature')) ?? ''
const TABLE_SECTION_START = TERMS.indexOf('### 4.1 Subscription Tiers')
assert.ok(TABLE_SECTION_START >= 0, 'fixture must contain subscription table section')
assert.ok(
  SUBSCRIPTION_TABLE_MARKER.length > 0,
  'fixture must contain subscription table header row',
)

function streamingHostAt(prefix: string): HTMLElement {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  renderer.update(prefix)
  return host
}

function htmlRootAt(prefix: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderStreamingMarkdown(prefix)
  return host
}

/** Table-row-like: starts with | and has at least one more pipe. */
function looksLikeRawTableRow(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1
}

/** Pipe-delimited row text visible outside any table cell (th/td). */
function findPipesOutsideTableCells(root: HTMLElement): string | null {
  if (root.querySelector('table') === null) return null
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('td, th').forEach((cell) => {
    cell.remove()
  })
  for (const line of clone.textContent.split('\n')) {
    if (looksLikeRawTableRow(line)) return line.trim().slice(0, 72)
  }
  return null
}

/**
 * Partial-table anti-patterns: committed table + raw pipe row in visible pending,
 * pipe rows in prose, or pipe text outside table cells anywhere in the live DOM.
 */
export function findPartialTableIssues(root: HTMLElement): string[] {
  const issues: string[] = []

  const inlinePending = root.querySelector(':scope > span.stream-pending')
  if (inlinePending instanceof HTMLElement && !inlinePending.hidden) {
    const text = inlinePending.textContent
    if (looksLikeRawTableRow(text)) {
      issues.push(`visible inline .stream-pending with raw table row: ${text.slice(0, 72)}`)
    }
  }

  const complete = root.querySelector('.stream-complete')
  if (complete) {
    const hasCommittedTable = complete.querySelector('table') !== null
    for (const el of complete.querySelectorAll(
      'p, div.stream-pending-paragraph, .stream-pending-block',
    )) {
      const text = el.textContent
      if (hasCommittedTable && looksLikeRawTableRow(text)) {
        issues.push(`pipe row in committed prose while table present: ${text.slice(0, 72)}`)
      }
    }

    const orphanPipeText = [...complete.children].filter((el) => {
      if (el.tagName === 'TABLE') return false
      const t = el.textContent
      return looksLikeRawTableRow(t)
    })
    if (orphanPipeText.length > 0) {
      issues.push(`orphan pipe row element sibling to committed table`)
    }
  }

  const outsideCells = findPipesOutsideTableCells(root)
  if (outsideCells) {
    issues.push(`pipe row text outside table cells: ${outsideCells}`)
  }

  return issues
}

function assertNoPartialTables(root: HTMLElement, label: string): void {
  const issues = findPartialTableIssues(root)
  assert.equal(issues.length, 0, `${label}: ${issues.join('; ')}`)
}

/** Cut indices: every char in a range, plus every newline in the full doc. */
function streamingCutIndices(text: string, focusStart: number, focusEnd: number): number[] {
  const cuts = new Set<number>([text.length])
  for (let i = focusStart; i <= Math.min(focusEnd, text.length); i++) {
    cuts.add(i)
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') cuts.add(i)
  }
  return [...cuts].sort((a, b) => a - b)
}

describe('Terms of Service streaming fixture', () => {
  it('loads the pinned fixture', () => {
    assert.ok(TERMS.includes('Copse Technologies'))
    assert.ok(TERMS.includes(SUBSCRIPTION_TABLE_MARKER))
  })

  it('renders nbsp metadata without literal entity text while streaming', () => {
    const versionLine =
      '**Version:** 3.0 &nbsp;&nbsp;|&nbsp;&nbsp; **Effective Date:** 2025-02-15 &nbsp;&nbsp;|&nbsp;&nbsp; **Last Updated:** 2025-02-10'
    const prefix = TERMS.slice(0, TERMS.indexOf(versionLine) + versionLine.length)
    const html = renderStreamingMarkdown(prefix)
    assert.doesNotMatch(html, /&amp;nbsp;/)
    const div = document.createElement('div')
    div.innerHTML = html
    assert.doesNotMatch(div.textContent, /&nbsp;/)
  })

  it('streams subscription table rows without raw pipe text in inline pending', () => {
    const tableStart = TERMS.indexOf(SUBSCRIPTION_TABLE_MARKER)
    const tableEnd = TERMS.indexOf('### 4.2 Payment Terms')
    assert.ok(tableStart >= 0 && tableEnd > tableStart)

    const tableChunk = TERMS.slice(TABLE_SECTION_START, tableEnd)
    const rowLines = tableChunk.split('\n').filter((line) => line.trimStart().startsWith('|'))

    for (const line of rowLines) {
      const cut = TERMS.indexOf(line) + line.length
      const prefix = TERMS.slice(0, cut)
      assertNoPartialTables(streamingHostAt(prefix), `renderer after row "${line.slice(0, 40)}…"`)
      assertNoPartialTables(htmlRootAt(prefix), `string after row "${line.slice(0, 40)}…"`)
    }
  })

  it('never shows partial table artifacts across incremental cuts in the fee table section', () => {
    const tableStart = TERMS.indexOf(SUBSCRIPTION_TABLE_MARKER)
    const tableEnd = TERMS.indexOf('### 4.2 Payment Terms')
    const cuts = streamingCutIndices(TERMS, tableStart - 80, tableEnd + 40)

    for (const cut of cuts) {
      const prefix = TERMS.slice(0, cut)
      assertNoPartialTables(streamingHostAt(prefix), `renderer cut=${String(cut)}`)
      assertNoPartialTables(htmlRootAt(prefix), `string cut=${String(cut)}`)
    }
  })

  it('never shows partial table artifacts across strided cuts of the full document', () => {
    const stride = 48
    for (let cut = stride; cut <= TERMS.length; cut += stride) {
      const prefix = TERMS.slice(0, cut)
      assertNoPartialTables(streamingHostAt(prefix), `renderer full-doc cut=${String(cut)}`)
      assertNoPartialTables(htmlRootAt(prefix), `string full-doc cut=${String(cut)}`)
    }
    assertNoPartialTables(streamingHostAt(TERMS), 'renderer full document')
    assertNoPartialTables(htmlRootAt(TERMS), 'string full document')
  })

  it('renders the committed fee table with all tier columns when complete', () => {
    const html = renderStreamingMarkdown(TERMS)
    assert.match(html, /<table>/)
    assert.match(html, /<th>Feature<\/th>/)
    assert.match(html, /<th>Enterprise Plan<\/th>/)
    assert.match(html, /<td>\$19 \/ month<\/td>/)
    assertNoPartialTables(htmlRootAt(TERMS), 'complete document')
  })

  it('findPartialTableIssues fails when raw pipe rows leak outside table cells', () => {
    const host = streamingHostAt(
      '| Feature | Free Plan | Pro Plan | Enterprise Plan |\n| --- | --- | --- | --- |\n| **Projects** | 1 | 10 | Unlimited |\n| **API Requests** | 1,000',
    )
    assertNoPartialTables(host, 'in-progress fee row')

    const pending = host.querySelector(':scope > span.stream-pending')
    assert.ok(pending instanceof HTMLElement)
    pending.hidden = false
    pending.textContent = '| **Support** | Community | Email | Dedicated |'
    const issues = findPartialTableIssues(host)
    assert.ok(issues.length > 0, 'must flag visible raw pipe row in inline pending')
    assert.match(issues.join(' '), /raw table row|outside table cells/)
  })
})
