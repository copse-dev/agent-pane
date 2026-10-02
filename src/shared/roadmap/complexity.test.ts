import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRoadmapComplexity, isRoadmapCategory, roadmapCategoryLabel } from './complexity.ts'

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
