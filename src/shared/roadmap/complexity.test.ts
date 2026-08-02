import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRoadmapComplexity,
  parseComplexityWord,
  isRoadmapCategory,
  parseCategoryWord,
  roadmapCategoryLabel,
} from './complexity.ts'

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

describe('parseCategoryWord', () => {
  it('reads a bare verdict', () => {
    assert.equal(parseCategoryWord('bug'), 'bug')
    assert.equal(parseCategoryWord('  Feature  '), 'feature')
    assert.equal(parseCategoryWord('project'), 'project')
  })

  it('tolerates chatty replies, first line only', () => {
    assert.equal(parseCategoryWord('Bug — crash on startup'), 'bug')
    assert.equal(parseCategoryWord('Feature — adds a toggle.'), 'feature')
    assert.equal(parseCategoryWord('Project — migration across three modules'), 'project')
    assert.equal(
      parseCategoryWord('I would not classify this.\nbug'),
      null,
      'ignores verdict on second line',
    )
  })

  it('rejects output with no verdict or embedded words', () => {
    assert.equal(parseCategoryWord(''), null)
    assert.equal(parseCategoryWord('bugging the system'), null)
    assert.equal(parseCategoryWord('featurette'), null)
  })
})

describe('isRoadmapComplexity', () => {
  it('guards stored frontmatter values', () => {
    assert.equal(isRoadmapComplexity('medium'), true)
    assert.equal(isRoadmapComplexity('frontier'), false)
    assert.equal(isRoadmapComplexity(undefined), false)
  })
})

describe('isRoadmapCategory', () => {
  it('guards stored frontmatter values', () => {
    assert.equal(isRoadmapCategory('bug'), true)
    assert.equal(isRoadmapCategory('feature'), true)
    assert.equal(isRoadmapCategory('project'), true)
    assert.equal(isRoadmapCategory('Bug'), false)
    assert.equal(isRoadmapCategory('featurette'), false)
    assert.equal(isRoadmapCategory(undefined), false)
    assert.equal(isRoadmapCategory(null), false)
    assert.equal(isRoadmapCategory(0), false)
    assert.equal(isRoadmapCategory({}), false)
  })
})

describe('roadmapCategoryLabel', () => {
  it('maps each category to its human label', () => {
    assert.equal(roadmapCategoryLabel('bug'), 'Bugs')
    assert.equal(roadmapCategoryLabel('feature'), 'Features')
    assert.equal(roadmapCategoryLabel('project'), 'Projects')
  })
})
