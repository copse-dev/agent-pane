import { splitTableRow, TABLE_SEP_RE } from './block-tokenizer.ts'
import { dropTrailingNewline } from './block-patterns.ts'
import { escapeHtml } from './escape.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderStreamingInline } from './render-pending-line.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

const FORMING_TABLE_CLASS = 'stream-table-forming'
const PENDING_ROW_CLASS = 'stream-pending-row'
const SEPARATOR_ROW_CLASS = 'stream-table-separator-pending'

function tableLines(source: string): string[] {
  const trimmed = dropTrailingNewline(source)
  if (trimmed === '') return []
  return trimmed.split('\n')
}

function visibleCellSource(raw: string): string {
  return raw.slice(0, pendingHoldIndex(raw))
}

function renderStreamingTableCell(raw: string): string {
  const visible = visibleCellSource(raw)
  return visible ? sanitizeRenderedMarkdown(renderStreamingInline(visible)) : ''
}

function setStreamingCellContent(cell: HTMLTableCellElement, raw: string): void {
  cell.innerHTML = renderStreamingTableCell(raw)
}

function ensureRow(parent: HTMLTableSectionElement, index: number): HTMLTableRowElement {
  return parent.rows[index] ?? parent.insertRow()
}

function syncRowCells(row: HTMLTableRowElement, cells: string[], tag: 'th' | 'td'): void {
  while (row.cells.length < cells.length) {
    row.appendChild(document.createElement(tag))
  }
  while (row.cells.length > cells.length) {
    row.lastElementChild?.remove()
  }
  cells.forEach((raw, i) => {
    const cell = row.cells[i]
    if (cell) setStreamingCellContent(cell, raw)
  })
}

/**
 * Forward-pass DOM updates for a GFM table still streaming (header, separator,
 * and/or in-progress body row). Does not re-render committed markdown.
 */
export function syncFormingTableDom(container: HTMLElement, source: string): void {
  const lines = tableLines(source)
  if (lines.length === 0) {
    container.replaceChildren()
    return
  }

  const existing = container.querySelector(`table.${FORMING_TABLE_CLASS}`)
  let table: HTMLTableElement
  if (existing instanceof Element && existing.tagName === 'TABLE') {
    table = existing as HTMLTableElement
  } else {
    container.replaceChildren()
    table = document.createElement('table')
    table.className = FORMING_TABLE_CLASS
    table.append(document.createElement('thead'), document.createElement('tbody'))
    container.appendChild(table)
  }

  const thead = table.tHead ?? table.createTHead()
  const tbody = table.tBodies[0] ?? table.createTBody()
  tbody.replaceChildren()

  const headerLine = lines[0]
  if (!headerLine) return
  syncRowCells(ensureRow(thead, 0), splitTableRow(headerLine), 'th')

  const sepLine = lines[1]
  if (!sepLine) return

  if (!TABLE_SEP_RE.test(sepLine)) {
    const sepRow = tbody.insertRow()
    sepRow.className = SEPARATOR_ROW_CLASS
    const colCount = Math.max(thead.rows[0]?.cells.length ?? 1, splitTableRow(sepLine).length, 1)
    syncRowCells(
      sepRow,
      Array.from({ length: colCount }, () => sepLine.trim()),
      'td',
    )
    return
  }

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.includes('|')) continue
    const row = tbody.insertRow()
    if (i === lines.length - 1 && !source.endsWith('\n')) {
      row.className = PENDING_ROW_CLASS
    }
    syncRowCells(row, splitTableRow(line), 'td')
  }
}

/** Update the in-progress body row on a committed table (forward-pass cells). */
export function syncPendingTableRowDom(table: HTMLTableElement, pendingRow: string): void {
  const cells = splitTableRow(pendingRow)
  const headerCols = table.tHead?.rows[0]?.cells.length
  const colCount = headerCols ?? Math.max(cells.length, 1)
  let tbody = table.tBodies[0]
  if (!tbody) {
    tbody = table.createTBody()
  }

  let row: HTMLTableRowElement | null = tbody.querySelector(`tr.${PENDING_ROW_CLASS}`)
  if (!(row instanceof Element) || row.tagName !== 'TR') {
    tbody.querySelectorAll(`tr.${PENDING_ROW_CLASS}`).forEach((r) => {
      r.remove()
    })
    row = tbody.insertRow()
    row.className = PENDING_ROW_CLASS
  }

  syncRowCells(
    row,
    Array.from({ length: colCount }, (_, i) => cells[i] ?? ''),
    'td',
  )
}

export function clearFormingTableDom(container: HTMLElement): void {
  container.replaceChildren()
}

export function removePendingTableRow(table: HTMLTableElement): void {
  table.querySelector(`tr.${PENDING_ROW_CLASS}`)?.remove()
}

/** Append an in-progress body row to the last committed table in rendered HTML. */
export function appendPendingTableRowHtml(rendered: string, pendingRow: string): string {
  const cells = splitTableRow(pendingRow)
  const headerMatch = rendered.match(/<thead>[\s\S]*?<\/thead>/g)
  const lastHeader = headerMatch?.at(-1) ?? ''
  const headerCols = (lastHeader.match(/<th[\s>]/g) ?? []).length
  const colCount = headerCols > 0 ? headerCols : Math.max(cells.length, 1)

  const rowHtml = Array.from({ length: colCount }, (_, i) => {
    const inner = renderStreamingTableCell(cells[i] ?? '')
    return `<td>${inner}</td>`
  }).join('')
  const pendingRowHtml = `<tr class="${PENDING_ROW_CLASS}">${rowHtml}</tr>`

  const closeTbody = '</tbody>'
  const closeIndex = rendered.lastIndexOf(closeTbody)
  if (closeIndex === -1) return `${rendered}${pendingRowHtml}`
  return `${rendered.slice(0, closeIndex)}${pendingRowHtml}${rendered.slice(closeIndex)}`
}

export function buildFormingTableHtml(source: string): string {
  const lines = tableLines(source)
  if (lines.length === 0) return ''

  const headerLine = lines[0]
  if (!headerLine) return ''
  const headerCells = splitTableRow(headerLine)
    .map((c) => `<th>${renderStreamingTableCell(c)}</th>`)
    .join('')

  const parts = [
    `<table class="${FORMING_TABLE_CLASS}"><thead><tr>${headerCells}</tr></thead><tbody>`,
  ]

  const sepLine = lines[1]
  if (sepLine && !TABLE_SEP_RE.test(sepLine)) {
    parts.push(`<tr class="${SEPARATOR_ROW_CLASS}"><td>${escapeHtml(sepLine.trim())}</td></tr>`)
  } else if (sepLine && TABLE_SEP_RE.test(sepLine)) {
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.includes('|')) continue
      const cells = splitTableRow(line)
        .map((c) => `<td>${renderStreamingTableCell(c)}</td>`)
        .join('')
      const rowClass =
        i === lines.length - 1 && !source.endsWith('\n') ? ` class="${PENDING_ROW_CLASS}"` : ''
      parts.push(`<tr${rowClass}>${cells}</tr>`)
    }
  }

  parts.push('</tbody></table>')
  return parts.join('')
}
