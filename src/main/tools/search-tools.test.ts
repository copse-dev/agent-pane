import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findFilesTool, searchCodeTool } from './search-tools.ts'
import { setIndexForTest } from '../services/search/file-index.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setRgAvailableForTest } from '../services/tool-availability.ts'
import { setIndexedGrepBackendForTest } from '../services/search/indexed-grep.ts'

const noSignal = new AbortController().signal

function runFindFiles(args: { pattern: string; max_results?: number }): Promise<string> {
  // Mirror the zod default for max_results so the test exercises the tool body directly.
  const max_results = args.max_results ?? 50
  return findFilesTool.execute({ pattern: args.pattern, max_results }, noSignal) as Promise<string>
}

describe('findFilesTool truncation flag', () => {
  afterEach(() => {
    setIndexForTest(null)
  })

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

describe('searchCodeTool pattern/query aliasing', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  // search_code's params are all optional post-aliasing; mirror the zod defaults
  // so the test drives the tool body directly.
  function runSearchCode(args: { pattern?: string; query?: string }): Promise<string> {
    return searchCodeTool.execute(
      {
        ...args,
        fixed_string: false,
        case_sensitive: false,
        max_results: 50,
        context_lines: 0,
      },
      noSignal,
    ) as Promise<string>
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-search-code-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'auth.ts'), 'export function authenticate() {}\n', 'utf-8')
    setRgAvailableForTest(true)
    setIndexedGrepBackendForTest('rg')
  })

  afterEach(async () => {
    setRgAvailableForTest(null)
    setIndexedGrepBackendForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('accepts the `query` alias in place of `pattern`', async () => {
    const out = await runSearchCode({ query: 'authenticate' })
    assert.match(out, /auth\.ts/)
  })

  it('reports a helpful message when neither pattern nor query is given', async () => {
    const out = await runSearchCode({})
    assert.match(out, /Provide a search pattern/)
    assert.match(out, /query/)
  })
})
