import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isGfmTableRowLine, tokenizeBlocks } from './block-tokenizer.ts'
import { renderMarkdown } from './renderer.ts'

const FIXTURE_PATH = resolve(
  process.cwd(),
  'packages/streaming-markdown/tests/fixtures/job-description-metadata.md',
)
const JD = readFileSync(FIXTURE_PATH, 'utf8')

const DEPT_LINE =
  '**Department:** Engineering &nbsp;&nbsp;|&nbsp;&nbsp; **Reports To:** Director of Engineering &nbsp;&nbsp;|&nbsp;&nbsp; **Location:** Remote (US) or San Francisco, CA'
const EMPLOY_LINE =
  '**Employment Type:** Full-Time &nbsp;&nbsp;|&nbsp;&nbsp; **Salary Range:** $160,000 – $210,000 + Equity'

describe('job description metadata pipes', () => {
  it('does not classify nbsp metadata lines as GFM table rows', () => {
    assert.equal(isGfmTableRowLine(DEPT_LINE), false)
    assert.equal(isGfmTableRowLine(EMPLOY_LINE), false)
    assert.equal(isGfmTableRowLine('| Category | Details |'), true)
  })

  it('tokenizes consecutive metadata lines as paragraphs, not a table', () => {
    const prefix = JD.slice(0, JD.indexOf('---'))
    const kinds = tokenizeBlocks(prefix).map((b) => b.kind)
    assert.ok(!kinds.includes('table'), `expected no table block, got ${kinds.join(', ')}`)
  })

  it('renders metadata as prose and keeps both lines visible', () => {
    const prefix = JD.slice(0, JD.indexOf('## 1.'))
    const html = renderMarkdown(prefix)
    assert.doesNotMatch(html, /<table>/)
    assert.match(html, /Department/)
    assert.match(html, /Employment Type/)
    assert.match(html, /\$160,000/)
    assert.match(html, /<hr>/)
  })

  it('still renders the benefits table when present', () => {
    const html = renderMarkdown(JD)
    const tables = html.match(/<table>/g) ?? []
    assert.equal(tables.length, 1)
    assert.match(html, /<th>Category<\/th>/)
    assert.match(html, /<td><strong>Health<\/strong><\/td>/)
  })
})
