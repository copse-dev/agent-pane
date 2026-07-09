import { el } from '../dom/helpers.ts'

const COPY_LABEL = 'Copy'
const COPIED_LABEL = 'Copied'
const FEEDBACK_MS = 1200

/**
 * Serialize a rendered GFM table to TSV (one row per line, cells tab-separated)
 * from the sanitized live DOM. Cell markup is dropped to its text; internal
 * whitespace is collapsed so tabs/newlines can't corrupt the TSV grid — the
 * result pastes cleanly into Numbers/Excel/Sheets.
 */
export function tableToTsv(table: HTMLTableElement): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
        .join('\t'),
    )
    .join('\n')
}

/**
 * Attach a hover "Copy" control to each committed markdown table under `root`
 * (mirrors `attachCodeBlockCopyButtons`). Forming tables (`.stream-table-forming`)
 * are skipped — the control lands once the table is committed. Idempotent via a
 * `data-copy-attached` guard.
 */
export function attachTableCopyButtons(root: ParentNode): void {
  const tables = root.querySelectorAll<HTMLTableElement>(
    'table:not(.stream-table-forming):not([data-copy-attached])',
  )
  for (const table of tables) {
    const parent = table.parentNode
    if (!parent) continue

    table.dataset['copyAttached'] = 'true'

    const shell = el('div', { class: 'table-copy-shell' })
    parent.insertBefore(shell, table)
    // A wide table (e.g. a long unbroken URL) scrolls inside this container
    // instead of stretching the whole conversation column. The copy button
    // stays outside it so it stays pinned while the table scrolls.
    const scroll = el('div', { class: 'table-copy-scroll' })
    scroll.append(table)
    shell.append(scroll)

    const copyBtn = el(
      'button',
      { type: 'button', class: 'table-copy', 'aria-label': 'Copy table as TSV' },
      COPY_LABEL,
    )
    copyBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void navigator.clipboard.writeText(tableToTsv(table)).then(() => {
        copyBtn.textContent = COPIED_LABEL
        setTimeout(() => {
          copyBtn.textContent = COPY_LABEL
        }, FEEDBACK_MS)
      })
    })
    shell.prepend(copyBtn)
  }
}
