import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { findFilesTool } from './search-tools.ts'
import { setIndexForTest } from '../services/file-index.ts'

const noSignal = new AbortController().signal

function runFindFiles(args: { pattern: string; max_results?: number }): Promise<string> {
  // Mirror the zod default for max_results so the test exercises the tool body directly.
  const max_results = args.max_results ?? 50
  return findFilesTool.execute({ pattern: args.pattern, max_results }, noSignal) as Promise<string>
}

describe('findFilesTool truncation flag', () => {
  afterEach(() => setIndexForTest(null))

  it('does NOT report truncation when total matches equal max_results (off-by-one)', async () => {
    setIndexForTest(['a.ts', 'b.ts', 'c.ts'])
    const out = await runFindFiles({ pattern: '*.ts', max_results: 3 })
    assert.doesNotMatch(out, /Truncated/)
    assert.equal(out.split('\n').length, 3)
  })

  it('reports truncation only when more matches exist than max_results', async () => {
    setIndexForTest(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const out = await runFindFiles({ pattern: '*.ts', max_results: 3 })
    assert.match(out, /\[Truncated at 3\]/)
    assert.equal(out.split('\n').length, 4) // 3 paths + truncation note
  })

  it('returns a no-match message when nothing matches', async () => {
    setIndexForTest(['a.ts'])
    const out = await runFindFiles({ pattern: '*.md' })
    assert.match(out, /No files match/)
  })
})
