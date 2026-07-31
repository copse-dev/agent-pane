// Replays the doctrine-compliance corpus (#744) through scoreDoctrineCompliance.
// Compliant cases must pass every rule; violation cases must fail exactly the
// listed rule ids — so a heuristic regression that starts failing a clean case
// (or stops catching a labeled violation) breaks CI.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DOCTRINE_RULE_IDS, scoreDoctrineCompliance } from './doctrine-compliance.ts'

const doctrineRuleIdSchema = z.enum(DOCTRINE_RULE_IDS)
const doctrineTranscriptSchema = z.object({
  userMessage: z.string(),
  userIntent: z.enum(['question', 'request', 'unknown']).optional(),
  inScopePaths: z.array(z.string()).optional(),
  toolCalls: z.array(
    z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      result: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  finalMessage: z.string(),
})
const doctrineCorpusSchema = z.object({
  cases: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      expectPass: z.boolean(),
      expectViolations: z.array(doctrineRuleIdSchema).optional(),
      transcript: doctrineTranscriptSchema,
    }),
  ),
})

const corpusPath = join(process.cwd(), 'tests/fixtures/doctrine-compliance-corpus.json')
const corpus = doctrineCorpusSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf8')))

describe('doctrine compliance corpus', () => {
  assert.ok(corpus.cases.length >= 8, 'corpus should cover compliant and violation arms')

  for (const c of corpus.cases) {
    it(`${c.id} — ${c.description}`, () => {
      const transcript = {
        userMessage: c.transcript.userMessage,
        toolCalls: c.transcript.toolCalls.map((call) => ({
          name: call.name,
          ...(call.args !== undefined ? { args: call.args } : {}),
          ...(call.result !== undefined ? { result: call.result } : {}),
          ...(call.status !== undefined ? { status: call.status } : {}),
        })),
        finalMessage: c.transcript.finalMessage,
        ...(c.transcript.userIntent !== undefined ? { userIntent: c.transcript.userIntent } : {}),
        ...(c.transcript.inScopePaths !== undefined
          ? { inScopePaths: c.transcript.inScopePaths }
          : {}),
      }
      const report = scoreDoctrineCompliance(transcript)
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
