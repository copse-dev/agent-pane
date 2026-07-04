import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { attachTableCopyButtons, tableToTsv } from './table-copy.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { qs, qsRequired } from '../dom/helpers.ts'

function installClipboard(): string[] {
  const writes: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (text: string): Promise<void> => {
          writes.push(text)
          return Promise.resolve()
        },
      },
    },
  })
  return writes
}

const TABLE_MD = '| Name | Status |\n| --- | --- |\n| alpha | done |\n| beta | pending |'

function tableRoot(md = TABLE_MD): HTMLElement {
  const root = document.createElement('div')
  root.className = 'message-text'
  root.innerHTML = renderMarkdown(md)
  return root
}

describe('tableToTsv', () => {
  it('serializes header + body rows as tab/newline TSV', () => {
    const root = tableRoot()
    const table = qsRequired<HTMLTableElement>(root, 'table')
    assert.equal(tableToTsv(table), 'Name\tStatus\nalpha\tdone\nbeta\tpending')
  })

  it('collapses internal whitespace so the TSV grid stays intact', () => {
    const root = tableRoot('| A | B |\n| --- | --- |\n| one two | `code` |')
    const table = qsRequired<HTMLTableElement>(root, 'table')
    assert.equal(tableToTsv(table), 'A\tB\none two\tcode')
  })
})

describe('attachTableCopyButtons', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })

  it('wraps a committed table in a shell with a copy button', () => {
    const root = tableRoot()
    attachTableCopyButtons(root)
    const button = qsRequired<HTMLButtonElement>(root, '.table-copy-shell button.table-copy')
    assert.equal(button.textContent, 'Copy')
    assert.equal(button.getAttribute('aria-label'), 'Copy table as TSV')
    assert.equal(qsRequired<HTMLTableElement>(root, 'table').dataset['copyAttached'], 'true')
  })

  it('copies TSV and flips to Copied, then resets', () => {
    const writes = installClipboard()
    const root = tableRoot()
    attachTableCopyButtons(root)
    const button = qsRequired<HTMLButtonElement>(root, 'button.table-copy')

    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    return Promise.resolve().then(() => {
      assert.deepEqual(writes, ['Name\tStatus\nalpha\tdone\nbeta\tpending'])
      assert.equal(button.textContent, 'Copied')
      mock.timers.tick(1300)
      assert.equal(button.textContent, 'Copy')
    })
  })

  it('skips forming tables and is idempotent', () => {
    const root = tableRoot()
    qsRequired<HTMLTableElement>(root, 'table').classList.add('stream-table-forming')
    attachTableCopyButtons(root)
    assert.equal(qs(root, '.table-copy-shell'), null) // forming table untouched

    qsRequired<HTMLTableElement>(root, 'table').classList.remove('stream-table-forming')
    attachTableCopyButtons(root)
    attachTableCopyButtons(root) // second pass must not double-wrap
    assert.equal(root.querySelectorAll('.table-copy-shell').length, 1)
    assert.equal(root.querySelectorAll('button.table-copy').length, 1)
  })
})
