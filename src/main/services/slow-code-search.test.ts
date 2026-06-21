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
})
