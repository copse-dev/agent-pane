import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINDING_CLASSES,
  decodeFinding,
  decodeFindings,
  findingId,
  isFindingClass,
  normalizeAnchoredText,
  normalizeClaim,
  type Finding,
} from './finding.ts'

const sample: Finding = {
  id: '0123456789abcdef',
  anchor: { path: 'src/a.ts', startLine: 3, endLine: 3 },
  claim: 'TS2322: Type string is not assignable to type number',
  class: 'type',
  severity: 'high',
  confidence: 'high',
  provenance: {
    raisedBy: [{ kind: 'stage0', id: 'stage0' }],
    corroboratedBy: [],
    challengedBy: [],
  },
  evidence: [
    { kind: 'citation', path: 'src/a.ts', startLine: 3, endLine: 3 },
    { kind: 'command', command: 'pnpm run typecheck', target: 'head', exitCode: 2, excerpt: '…' },
  ],
  verdict: { status: 'confirmed', reason: 'reported on head, absent on base' },
}

describe('finding schema', () => {
  it('round-trips a finding through JSON', () => {
    const decoded = decodeFinding(JSON.parse(JSON.stringify(sample)))
    assert.deepEqual(decoded, sample)
    assert.deepEqual(decodeFindings([sample, sample]), [sample, sample])
  })

  it('rejects a finding outside the B4 class list or with a malformed id', () => {
    assert.equal(decodeFinding({ ...sample, class: 'docs' }), null)
    assert.equal(decodeFinding({ ...sample, class: 'style' }), null)
    assert.equal(decodeFinding({ ...sample, id: 'not-hex' }), null)
    assert.equal(
      decodeFinding({ ...sample, provenance: { ...sample.provenance, raisedBy: [] } }),
      null,
    )
  })

  it('isFindingClass agrees with the tuple it is built from', () => {
    for (const member of FINDING_CLASSES) assert.equal(isFindingClass(member), true)
    assert.equal(isFindingClass('docs'), false)
    assert.equal(isFindingClass(undefined), false)
  })
})

describe('findingId', () => {
  const base = {
    class: 'type',
    path: 'src/a.ts',
    anchoredText: '  const x: number = "one"  ',
    claim: 'TS2322: Type string is not assignable to type number.',
  } as const

  it('is sixteen hex characters and deterministic', () => {
    const id = findingId(base)
    assert.match(id, /^[0-9a-f]{16}$/)
    assert.equal(findingId(base), id)
  })

  it('survives a move of the anchored lines and a reformat of the claim', () => {
    const id = findingId(base)
    assert.equal(findingId({ ...base, anchoredText: 'const x: number = "one"' }), id)
    assert.equal(
      findingId({ ...base, claim: '  ts2322:   type string is not assignable to type number' }),
      id,
    )
  })

  it('changes when the content, the claim, the path or the class changes', () => {
    const id = findingId(base)
    assert.notEqual(findingId({ ...base, anchoredText: 'const x: number = 1' }), id)
    assert.notEqual(findingId({ ...base, claim: 'TS2339: Property does not exist' }), id)
    assert.notEqual(findingId({ ...base, path: 'src/b.ts' }), id)
    assert.notEqual(findingId({ ...base, class: 'build' }), id)
  })

  it('normalises claims and anchored text as documented', () => {
    assert.equal(normalizeClaim('  Fails   on head. '), 'fails on head')
    assert.equal(normalizeAnchoredText(' a \n\n  b\r\n'), 'a\nb')
  })
})
