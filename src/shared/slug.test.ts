import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { slugify } from './slug.ts'

describe('slugify', () => {
  it('lowercases and dash-joins, trimming stray dashes', () => {
    assert.equal(slugify('Gemini CLI'), 'gemini-cli')
    assert.equal(slugify('  Claude  Code!  '), 'claude-code')
    assert.equal(slugify('Roadmap'), 'roadmap')
  })

  it('returns an empty string when nothing alphanumeric remains', () => {
    assert.equal(slugify('!!!'), '')
    assert.equal(slugify(''), '')
  })

  it('caps the slug at 64 characters', () => {
    assert.equal(slugify('a'.repeat(80)), 'a'.repeat(64))
  })
})
