import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRoadmapComplexity, parseComplexityWord, tierToComplexity } from './complexity.ts'

describe('parseComplexityWord', () => {
  it('reads a bare verdict', () => {
    assert.equal(parseComplexityWord('low'), 'low')
    assert.equal(parseComplexityWord('  High  '), 'high')
  })

  it('tolerates chatty replies, first line only', () => {
    assert.equal(parseComplexityWord('Medium — touches two files.'), 'medium')
    assert.equal(parseComplexityWord('Verdict: high\nBecause of the refactor.'), 'high')
    assert.equal(parseComplexityWord('I would not classify this.\nlow'), null)
  })

  it('rejects output with no verdict or embedded words', () => {
    assert.equal(parseComplexityWord(''), null)
    assert.equal(parseComplexityWord('lowering the bar is highly complex'), null)
  })
})

describe('tierToComplexity', () => {
  it('maps the three classifier tiers', () => {
    assert.equal(tierToComplexity('fast'), 'low')
    assert.equal(tierToComplexity('balanced'), 'medium')
    assert.equal(tierToComplexity('frontier'), 'high')
  })
})

describe('isRoadmapComplexity', () => {
  it('guards stored frontmatter values', () => {
    assert.equal(isRoadmapComplexity('medium'), true)
    assert.equal(isRoadmapComplexity('frontier'), false)
    assert.equal(isRoadmapComplexity(undefined), false)
  })
})
