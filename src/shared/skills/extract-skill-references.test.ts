import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractSkillFileReferences } from './extract-skill-references.ts'

describe('extractSkillFileReferences', () => {
  it('returns no references for text without bundle-relative paths', () => {
    assert.deepEqual(extractSkillFileReferences('# Skill\n\nDo a thing locally.'), [])
    assert.deepEqual(extractSkillFileReferences('see the references/ directory'), [])
  })

  it('extracts a backticked bare-text reference', () => {
    const text = 'This skill references `references/patterns.md` for detailed guidance.'
    assert.deepEqual(extractSkillFileReferences(text), ['references/patterns.md'])
  })

  it('extracts a reference inside a markdown link', () => {
    const text = 'See [the patterns](references/patterns.md) before running this.'
    assert.deepEqual(extractSkillFileReferences(text), ['references/patterns.md'])
  })

  it('extracts scripts/ and assets/ paths too', () => {
    const text = 'Run `scripts/setup.sh` then check assets/logo.png.'
    assert.deepEqual(extractSkillFileReferences(text), ['assets/logo.png', 'scripts/setup.sh'])
  })

  it('de-duplicates and sorts', () => {
    const text = '`references/patterns.md` ... again: references/patterns.md, then scripts/a.sh'
    assert.deepEqual(extractSkillFileReferences(text), ['references/patterns.md', 'scripts/a.sh'])
  })

  it('ignores a bare directory mention with no filename', () => {
    assert.deepEqual(extractSkillFileReferences('Files live under references/ in this bundle.'), [])
  })

  it('ignores external links and unrelated slash-separated text', () => {
    const text = 'https://example.com/references/x.md and a/b/c.md are not bundle references.'
    assert.deepEqual(extractSkillFileReferences(text), [])
  })

  it('strips trailing sentence punctuation', () => {
    assert.deepEqual(extractSkillFileReferences('See references/patterns.md.'), [
      'references/patterns.md',
    ])
    assert.deepEqual(extractSkillFileReferences('(see references/patterns.md)'), [
      'references/patterns.md',
    ])
  })
})
