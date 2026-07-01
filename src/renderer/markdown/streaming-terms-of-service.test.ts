/**
 * Regression: Terms of Service fixture — dense prose, nbsp metadata, numbered lists,
 * fee table, blockquotes, and fenced address block. Catches partial table renders
 * (raw | cell | text in inline pending) while streaming.
 */
import '../../../tests/setup-dom-jsdom.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

const TERMS_PATH = resolve(process.cwd(), 'tests/fixtures/terms-of-service-streaming.md')
const TERMS = readFileSync(TERMS_PATH, 'utf8')

const SUBSCRIPTION_TABLE_MARKER = '| Feature | Free Plan | Pro Plan | Enterprise Plan |'
const TABLE_SECTION_START = TERMS.indexOf('### 4.1 Subscription Tiers')
assert.ok(TABLE_SECTION_START >= 0, 'fixture must contain subscription table section')

/** Visible streaming HTML: committed + forming + live tail (matches convergence helper). */
function extractStreamingDisplay(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector('.stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector('.stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector('.stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function streamingDisplayAt(prefix: string): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  renderer.update(prefix)
  return extractStreamingDisplay(host)
}

/** Table-row-like: starts with | and has at least one more pipe. */
function looksLikeRawTableRow(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1
}

/**
 * Partial-table anti-patterns seen in the wild: committed table + raw pipe row in
 * inline pending, or pipe rows rendered as prose outside any table cell.
 */
export function findPartialTableIssues(html: string): string[] {
  const issues: string[] = []
  const host = document.createElement('div')
  host.innerHTML = html

  for (const el of host.querySelectorAll('span.stream-pending')) {
    if (el.classList.contains('stream-pending-block')) continue
    const text = el.textContent ?? ''
    if (looksLikeRawTableRow(text)) {
      issues.push(`inline .stream-pending with raw table row: ${text.slice(0, 72)}`)
    }
  }

  const complete = host.querySelector('.stream-complete')
  if (complete) {
    const hasCommittedTable = complete.querySelector('table') !== null
    for (const p of complete.querySelectorAll('p, div.stream-pending-paragraph')) {
      const text = p.textContent ?? ''
      if (hasCommittedTable && looksLikeRawTableRow(text) && (p.textContent?.match(/\|/g)?.length ?? 0) >= 2) {
        issues.push(`pipe row in prose block while table committed: ${text.slice(0, 72)}`)
      }
    }
  }

  // When a table exists, extra body rows must be tr.stream-pending-row — not duplicated forming-only tables with raw text siblings
  const tables = host.querySelectorAll('table')
  if (tables.length > 0) {
    const orphanPipeText = [...host.querySelectorAll('.stream-complete > *')].filter((el) => {
      if (!(el instanceof Element)) return false
      if (el.tagName === 'TABLE') return false
      const t = el.textContent ?? ''
      return looksLikeRawTableRow(t) && t.includes('Plan')
    })
    if (orphanPipeText.length > 0) {
      issues.push(`orphan pipe row element sibling to committed table`)
    }
  }

  return issues
}

function assertNoPartialTables(html: string, label: string): void {
  const issues = findPartialTableIssues(html)
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
      const html = streamingDisplayAt(prefix)
      assertNoPartialTables(html, `after row "${line.slice(0, 40)}…"`)
    }
  })

  it('never shows partial table artifacts across incremental cuts in the fee table section', () => {
    const tableStart = TERMS.indexOf(SUBSCRIPTION_TABLE_MARKER)
    const tableEnd = TERMS.indexOf('### 4.2 Payment Terms')
    const cuts = streamingCutIndices(TERMS, tableStart - 80, tableEnd + 40)

    for (const cut of cuts) {
      const html = streamingDisplayAt(TERMS.slice(0, cut))
      assertNoPartialTables(html, `cut=${String(cut)}`)
    }
  })

  it('never shows partial table artifacts across strided cuts of the full document', () => {
    const stride = 48
    for (let cut = stride; cut <= TERMS.length; cut += stride) {
      const html = streamingDisplayAt(TERMS.slice(0, cut))
      assertNoPartialTables(html, `full-doc cut=${String(cut)}`)
    }
    assertNoPartialTables(streamingDisplayAt(TERMS), 'full document')
  })

  it('renders the committed fee table with all tier columns when complete', () => {
    const html = renderStreamingMarkdown(TERMS)
    assert.match(html, /<table>/)
    assert.match(html, /<th>Feature<\/th>/)
    assert.match(html, /<th>Enterprise Plan<\/th>/)
    assert.match(html, /<td>\$19 \/ month<\/td>/)
    assertNoPartialTables(html, 'complete document')
  })
})
