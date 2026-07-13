import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRoadmapFit, parseFitVerdict } from './fit.ts'

describe('parseFitVerdict', () => {
  it('reads a bare verdict and tolerates chatty first lines', () => {
    assert.equal(parseFitVerdict('likely'), 'likely')
    assert.equal(parseFitVerdict('Verdict: partial — misses the migration.'), 'partial')
    assert.equal(parseFitVerdict('Unlikely\n- prompt targets the wrong file'), 'unlikely')
  })

  it('matches "unlikely" before falling back to the "likely" substring', () => {
    // \b(likely|partial|unlikely) — "unlikely" contains "likely"; the word
    // boundary must keep the alternatives distinct.
    assert.equal(parseFitVerdict('this is unlikely to work'), 'unlikely')
  })

  it('returns null when no verdict is present in the first line', () => {
    assert.equal(parseFitVerdict(''), null)
    assert.equal(parseFitVerdict('no verdict here\nlikely'), null)
  })
})

describe('isRoadmapFit', () => {
  it('guards stored frontmatter values', () => {
    assert.equal(isRoadmapFit('partial'), true)
    assert.equal(isRoadmapFit('maybe'), false)
  })
})
