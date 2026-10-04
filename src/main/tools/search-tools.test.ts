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

async function runFindFiles(args: { pattern: string; max_results?: number }): Promise<string> {
  // Mirror the zod default for max_results so the test exercises the tool body directly.
  const max_results = args.max_results ?? 50
  const result = await findFilesTool.execute({ pattern: args.pattern, max_results }, noSignal)
  return typeof result === 'string' ? result : result.result
}

describe('findFilesTool truncation flag', () => {
  const testRoot = '/tmp/copse-panel-find-files-test-root'
  let restoreWorkspace: (() => void) | undefined

  beforeEach(() => {
    restoreWorkspace = setWorkspaceRootForTest(testRoot)
  })

  afterEach(() => {
    setIndexForTest(null, testRoot)
    restoreWorkspace?.()
  })

  it('does NOT report truncation when total matches equal max_results (off-by-one)', async () => {
    setIndexForTest(['a.ts', 'b.ts', 'c.ts'], testRoot)
    const out = await runFindFiles({ pattern: '*.ts', max_results: 3 })
    assert.doesNotMatch(out, /Truncated/)
    assert.equal(out.split('\n').length, 3)
  })

  it('reports truncation only when more matches exist than max_results', async () => {
    setIndexForTest(['a.ts', 'b.ts', 'c.ts', 'd.ts'], testRoot)
    const out = await runFindFiles({ pattern: '*.ts', max_results: 3 })
    assert.match(out, /\[Truncated at 3\]/)
    assert.equal(out.split('\n').length, 4) // 3 paths + truncation note
  })

  it('returns a no-match message when nothing matches', async () => {
    setIndexForTest(['a.ts'], testRoot)
    const out = await runFindFiles({ pattern: '*.md' })
    assert.match(out, /No files match/)
  })

  it('finds bare filenames and extension globs at any depth', async () => {
    setIndexForTest(['package.json', 'packages/app/package.json', 'src/main.ts'], testRoot)
    assert.equal(
      await runFindFiles({ pattern: 'package.json' }),
      'package.json\npackages/app/package.json',
    )
    assert.equal(await runFindFiles({ pattern: '*.ts' }), 'src/main.ts')
  })

  it('keeps path-qualified globs scoped to their directory', async () => {
    setIndexForTest(['src/main.ts', 'src/nested/other.ts', 'test/main.ts'], testRoot)
    assert.equal(await runFindFiles({ pattern: 'src/*.ts' }), 'src/main.ts')
  })
})

describe('searchCodeTool pattern/query aliasing', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  // search_code's params are all optional post-aliasing; mirror the zod defaults
  // so the test drives the tool body directly.
  async function runSearchCode(args: { pattern?: string; query?: string }): Promise<string> {
    const result = await searchCodeTool.execute(
      {
        ...args,
        fixed_string: false,
        case_sensitive: false,
        max_results: 50,
        context_lines: 0,
      },
      noSignal,
    )
    return typeof result === 'string' ? result : result.result
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

describe('searchCodeTool empty results under file_glob', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  async function runSearchCode(args: {
    pattern: string
    file_glob?: string
    path?: string
  }): Promise<string> {
    const result = await searchCodeTool.execute(
      { ...args, fixed_string: false, case_sensitive: false, max_results: 50, context_lines: 0 },
      noSignal,
    )
    return typeof result === 'string' ? result : result.result
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-search-code-glob-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'auth.ts'), 'export function authenticate() {}\n', 'utf-8')
    await writeFile(join(tempRoot, 'view.tsx'), 'export const other = 1\n', 'utf-8')
    setRgAvailableForTest(true)
    setIndexedGrepBackendForTest('rg')
  })

  afterEach(async () => {
    setRgAvailableForTest(null)
    setIndexedGrepBackendForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('says the pattern matches outside a glob that filtered it away', async () => {
    const out = await runSearchCode({ pattern: 'authenticate', file_glob: '*.tsx' })
    assert.match(out, /^No matches found within file_glob "\*\.tsx"\./)
    assert.match(out, /does match outside that glob \(e\.g\. auth\.ts\)/)
  })

  it('does not claim matches outside the glob when the pattern is absent everywhere', async () => {
    const out = await runSearchCode({ pattern: 'no_such_symbol', file_glob: '*.tsx' })
    assert.match(out, /^No matches found within file_glob/)
    assert.doesNotMatch(out, /does match outside/)
  })

  it('points at brace sets when the glob uses `|` as alternation', async () => {
    const out = await runSearchCode({ pattern: 'authenticate', file_glob: '*auth*|*view*' })
    assert.match(out, /not a regex/)
    assert.match(out, /\{\*a\*,\*b\*\}/)
  })

  it('leaves the plain message for an empty search without a glob', async () => {
    assert.equal(await runSearchCode({ pattern: 'no_such_symbol' }), 'No matches found.')
  })

  it('still returns matches normally when the glob matches', async () => {
    const out = await runSearchCode({ pattern: 'authenticate', file_glob: '*.ts' })
    assert.match(out, /auth\.ts:1:/)
  })
})
