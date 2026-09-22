import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { FINDING_CLASSES, type Finding } from './finding.ts'
import { SARIF_SCHEMA, SARIF_VERSION, toSarif } from './sarif.ts'

const finding: Finding = {
  id: '0123456789abcdef',
  anchor: { path: 'src/a.ts', startLine: 3, endLine: 4 },
  claim: 'The function returns the difference.',
  class: 'contract',
  severity: 'high',
  confidence: 'medium',
  provenance: {
    raisedBy: [{ kind: 'model', id: 'm1', lens: 'correctness' }],
    corroboratedBy: [],
    challengedBy: [],
  },
  evidence: [{ kind: 'citation', path: 'src/a.ts', startLine: 3, endLine: 4 }],
  verdict: { status: 'unverified', reason: 'a - b' },
}

/** The slice of SARIF 2.1.0 a consumer like code scanning reads. */
const sarifShape = z.object({
  $schema: z.literal(SARIF_SCHEMA),
  version: z.literal(SARIF_VERSION),
  runs: z
    .array(
      z.object({
        tool: z.object({
          driver: z.object({
            name: z.string(),
            version: z.string(),
            rules: z.array(
              z.object({ id: z.string(), shortDescription: z.object({ text: z.string() }) }),
            ),
          }),
        }),
        originalUriBaseIds: z.object({ SRCROOT: z.object({ uri: z.string() }) }).optional(),
        results: z.array(
          z.object({
            ruleId: z.string(),
            level: z.enum(['note', 'warning', 'error']),
            message: z.object({ text: z.string() }),
            locations: z.array(
              z.object({
                physicalLocation: z.object({
                  artifactLocation: z.object({ uri: z.string(), uriBaseId: z.string() }),
                  region: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
                }),
              }),
            ),
            partialFingerprints: z.record(z.string(), z.string()),
            properties: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
    )
    .length(1),
})

describe('toSarif', () => {
  it('emits a valid 2.1.0 log with the identity in partialFingerprints and the rest in properties', () => {
    const log = sarifShape.parse(
      toSarif(
        [
          finding,
          { ...finding, id: 'fedcba9876543210', anchor: { path: 'package.json' }, severity: 'low' },
        ],
        {
          toolVersion: '0.1.0',
          repositoryRoot: '/repo',
          headCommit: 'b'.repeat(40),
        },
      ),
    )
    const run = log.runs[0]
    assert.ok(run)
    assert.equal(run.tool.driver.rules.length, FINDING_CLASSES.length)
    assert.equal(run.originalUriBaseIds?.SRCROOT.uri, 'file:///repo/')
    const [first, second] = run.results
    assert.ok(first && second)
    assert.equal(first.ruleId, 'contract')
    assert.equal(first.level, 'error')
    assert.deepEqual(first.partialFingerprints, { 'copse/findingId': '0123456789abcdef' })
    assert.deepEqual(first.locations[0]?.physicalLocation.region, { startLine: 3, endLine: 4 })
    assert.deepEqual(first.properties['verdict'], finding.verdict)
    assert.equal(second.level, 'note')
    assert.equal(second.locations[0]?.physicalLocation.region, undefined)
  })
})
