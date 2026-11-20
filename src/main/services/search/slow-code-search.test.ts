import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  compileSlowSearchMatcher,
  createGitignoreMatcher,
  looksLikeRiskyRegex,
  slowCodeSearch,
} from './slow-code-search.ts'

describe('compileSlowSearchMatcher', () => {
  it('rejects invalid regex', () => {
    const r = compileSlowSearchMatcher('[', { fixedString: false, caseSensitive: false })
    assert.ok('error' in r)
  })

  it('rejects risky nested quantifiers', () => {
    assert.ok(looksLikeRiskyRegex('(a+)+$'))
    const r = compileSlowSearchMatcher('(a+)+$', { fixedString: false, caseSensitive: false })
    assert.ok('error' in r)
  })

  it('matches fixed strings case-insensitively', () => {
    const r = compileSlowSearchMatcher('Hello', { fixedString: true, caseSensitive: false })
    assert.ok('matcher' in r)
    assert.ok(r.matcher('hello world'))
  })
})

describe('createGitignoreMatcher', () => {
  it('ignores paths matched by gitignore patterns', () => {
    const ig = createGitignoreMatcher(['dist/', '*.log'])
    assert.ok(ig.isIgnored('dist/out.js', false))
    assert.ok(ig.isIgnored('tmp/debug.log', false))
    assert.ok(!ig.isIgnored('src/index.ts', false))
  })

  // GHSA-fc5q-39xc-vjpf: `.gitignore` lines come from the repository, and
  // `+(*a)b` backtracks exponentially in picomatch (`contains` leaves it
  // unanchored, so it needs a tail that fails).
  it('reports a timeout for patterns that blow the time budget instead of hanging', () => {
    const ig = createGitignoreMatcher(['+(*a)b', '*.log'])
    const started = Date.now()
    assert.equal(ig.isIgnored(`${'a'.repeat(48)}!`, false), 'timeout')
    assert.equal(ig.isIgnored('tmp/debug.log', false), true)
    assert.ok(Date.now() - started < 5_000, `took ${String(Date.now() - started)}ms`)
  })
})

describe('slowCodeSearch', () => {
  it('honors gitignore and file_glob in fallback walk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-slow-search-'))
    await fs.mkdir(join(root, 'dist'))
    await fs.mkdir(join(root, 'src'))
    await fs.writeFile(join(root, 'dist', 'secret.ts'), 'FINDME dist\n')
    await fs.writeFile(join(root, 'src', 'keep.ts'), 'FINDME src\n')
    await fs.writeFile(join(root, 'src', 'skip.js'), 'FINDME js\n')
    await fs.writeFile(join(root, '.gitignore'), 'dist/\n')

    const hits = await slowCodeSearch({
      searchRoot: root,
      pattern: 'FINDME',
      maxResults: 10,
      fixedString: true,
      caseSensitive: false,
      fileGlob: '*.ts',
    })

    assert.match(hits, /keep\.ts:1/)
    assert.doesNotMatch(hits, /dist/)
    assert.doesNotMatch(hits, /skip\.js/)
  })

  it('returns a hint when file_glob backtracks past its budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-slow-search-'))
    await fs.writeFile(join(root, `${'a'.repeat(48)}!`), 'FINDME\n')
    const started = Date.now()
    const out = await slowCodeSearch({
      searchRoot: root,
      pattern: 'FINDME',
      maxResults: 10,
      fixedString: true,
      fileGlob: '+(*a)',
    })
    assert.match(out, /took too long to match/)
    assert.ok(Date.now() - started < 5_000, `took ${String(Date.now() - started)}ms`)
  })

  // Directories are matched in one batch; a slow name later in the directory
  // must not cost the results found before it, as with one match per entry.
  it('keeps results found before a slow file_glob entry once maxResults is met', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-slow-search-'))
    await fs.writeFile(join(root, 'a'), 'FINDME\n')
    await fs.writeFile(join(root, `${'a'.repeat(48)}!`), 'FINDME\n')
    const out = await slowCodeSearch({
      searchRoot: root,
      pattern: 'FINDME',
      maxResults: 1,
      fixedString: true,
      fileGlob: '+(*a)',
    })
    assert.match(out, /a:1: FINDME/)
    assert.doesNotMatch(out, /took too long to match/)
  })

  // A timed-out `.gitignore` must not lift its exclusions for the rest of the
  // walk: the search stops instead of reading ignored files.
  it('stops instead of searching ignored files when .gitignore times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-slow-search-'))
    await fs.writeFile(join(root, '.gitignore'), '+(*a)b\nsecret/\n')
    await fs.writeFile(join(root, 'a.txt'), 'FINDME public\n')
    await fs.writeFile(join(root, `${'a'.repeat(48)}!`), 'nothing\n')
    await fs.mkdir(join(root, 'secret'))
    await fs.writeFile(join(root, 'secret', 'key.txt'), 'FINDME secret\n')
    const started = Date.now()
    const out = await slowCodeSearch({
      searchRoot: root,
      pattern: 'FINDME',
      maxResults: 10,
      fixedString: true,
    })
    assert.match(out, /a\.txt:1: FINDME public/)
    assert.doesNotMatch(out, /secret/)
    assert.match(out, /\.gitignore patterns took too long/)
    assert.ok(Date.now() - started < 5_000, `took ${String(Date.now() - started)}ms`)
  })
})
