// Replays the doctrine-compliance corpus (#744) through scoreDoctrineCompliance.
// Compliant cases must pass every rule; violation cases must fail exactly the
// listed rule ids — so a heuristic regression that starts failing a clean case
// (or stops catching a labeled violation) breaks CI.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  scoreDoctrineCompliance,
  type DoctrineRuleId,
  type DoctrineTranscript,
} from './doctrine-compliance.ts'

interface CorpusCase {
  id: string
  description: string
  expectPass: boolean
  expectViolations?: DoctrineRuleId[]
  transcript: DoctrineTranscript
}

interface DoctrineCorpus {
  cases: CorpusCase[]
}

const corpusPath = join(process.cwd(), 'tests/fixtures/doctrine-compliance-corpus.json')
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as DoctrineCorpus

describe('doctrine compliance corpus', () => {
  assert.ok(corpus.cases.length >= 8, 'corpus should cover compliant and violation arms')

  for (const c of corpus.cases) {
    it(`${c.id} — ${c.description}`, () => {
      const report = scoreDoctrineCompliance(c.transcript)
      if (c.expectPass) {
        assert.equal(report.pass, true, `violations: ${report.violations.join(', ')}`)
        assert.deepEqual(report.violations, [])
        return
      }
      assert.equal(report.pass, false, 'expected at least one doctrine violation')
      const expected = [...(c.expectViolations ?? [])].sort()
      assert.ok(expected.length > 0, 'violation cases must declare expectViolations')
      assert.deepEqual([...report.violations].sort(), expected)
    })
  }
})
