import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decodeOwnerReviewEvidence,
  decodeQuarantineAccountability,
  decodeReleaseExclusions,
  ownerReviewApiPath,
  ownerReviewErrors,
  quarantineReleaseErrors,
  quarantineScopeDigest,
  type ReleaseExclusion,
} from './e2e-release-policy.mts'

function quarantine(): ReleaseExclusion {
  return {
    spec: 'tests/e2e/example.e2e.ts',
    category: 'quarantine',
    reason: 'Actual native approval journey lacks current CI evidence',
    coverage: 'Component assertions do not establish native acceptance',
    markers: ['wdio.ci.conf.ts: exclude'],
    accountability: {
      owner: 'maintainer',
      disposition: 'restore',
      nextStep: 'Repair the fixture and prove the real approval journey',
    },
  }
}

function waived(): ReleaseExclusion {
  const entry = quarantine()
  assert.ok(entry.accountability)
  entry.accountability.waiver = {
    reviewedBy: 'maintainer',
    reviewedOn: '2026-10-04',
    expiresOn: '2026-10-11',
    decisionUrl: 'https://github.com/copse-dev/agent-pane/issues/2719#issuecomment-123',
    reason: 'Explicit bounded owner decision for this fixture',
    scopeDigest: quarantineScopeDigest(entry),
  }
  return entry
}

describe('quarantine release acceptance', () => {
  it('does not turn person assignment or repair disposition into release acceptance', () => {
    const entry = quarantine()
    assert.equal(quarantineReleaseErrors([entry], '2026-10-04').length, 1)
    assert.ok(entry.accountability)
    entry.accountability.owner = null
    assert.equal(quarantineReleaseErrors([entry], '2026-10-04').length, 2)
  })

  it('expires a waiver at the beginning of its UTC expiry date and bounds its duration', () => {
    const entry = waived()
    assert.deepEqual(quarantineReleaseErrors([entry], '2026-10-10'), [])
    assert.match(quarantineReleaseErrors([entry], '2026-10-11').join('\n'), /expired/)
    assert.ok(entry.accountability?.waiver)
    entry.accountability.waiver.expiresOn = '2026-10-19'
    assert.match(quarantineReleaseErrors([entry], '2026-10-04').join('\n'), /within 14 days/)
    entry.accountability.waiver.expiresOn = '2026-10-04'
    assert.match(quarantineReleaseErrors([entry], '2026-10-04').join('\n'), /within 14 days/)
  })

  it('rejects a different reviewer, a future review and any changed evidence scope', () => {
    const entry = waived()
    assert.ok(entry.accountability?.waiver)
    entry.accountability.waiver.reviewedBy = 'other-person'
    entry.accountability.waiver.reviewedOn = '2026-10-05'
    entry.markers.push('this.skip')
    const errors = quarantineReleaseErrors([entry], '2026-10-04').join('\n')
    assert.match(errors, /accountable person/)
    assert.match(errors, /future/)
    assert.match(errors, /current exclusion and evidence/)
    const prior = waived()
    prior.coverage = 'New compensating evidence changes what is accepted'
    assert.match(quarantineReleaseErrors([prior], '2026-10-04').join('\n'), /current exclusion/)
  })

  it('keeps deliberate service tiers, platform gates and host skips separate from quarantines', () => {
    for (const category of ['external-service', 'platform', 'environment'] as const) {
      const entry = quarantine()
      entry.category = category
      delete entry.accountability
      assert.deepEqual(quarantineReleaseErrors([entry], '2026-10-04'), [])
    }
    assert.match(
      quarantineReleaseErrors([quarantine(), quarantine()], '2026-10-04').join('\n'),
      /Duplicate exclusion/,
    )
    assert.throws(() => quarantineReleaseErrors([], '2026-02-30'), /Invalid release review date/)
  })

  it('decodes policy without dependency installation and rejects missing or fabricated review fields', () => {
    const entry = waived()
    assert.deepEqual(decodeReleaseExclusions({ version: 2, entries: [entry] }), [entry])
    assert.equal(decodeReleaseExclusions({ version: 1, entries: [entry] }), null)
    assert.equal(
      decodeReleaseExclusions({ version: 2, entries: [{ ...entry, accountability: undefined }] }),
      null,
    )
    assert.ok(entry.accountability?.waiver)
    for (const patch of [
      { owner: 'Renderer team' },
      { disposition: 'accepted' },
      { nextStep: ' ' },
      { approved: true },
      { waiver: { ...entry.accountability.waiver, reviewedOn: '2026-02-30' } },
      {
        waiver: { ...entry.accountability.waiver, decisionUrl: 'https://other.example/acceptance' },
      },
      { waiver: { ...entry.accountability.waiver, scopeDigest: 'not-a-scope' } },
      { waiver: { ...entry.accountability.waiver, extraApproval: true } },
    ])
      assert.equal(decodeQuarantineAccountability({ ...entry.accountability, ...patch }), null)
    assert.equal(
      decodeReleaseExclusions({ version: 2, entries: [{ ...entry, category: 'platform' }] }),
      null,
    )
  })

  it('resolves only owner decision endpoints inside this repository', () => {
    assert.equal(
      ownerReviewApiPath('https://github.com/copse-dev/agent-pane/issues/2719#issuecomment-123'),
      'repos/copse-dev/agent-pane/issues/comments/123',
    )
    assert.equal(
      ownerReviewApiPath('https://github.com/copse-dev/agent-pane/pull/3456#pullrequestreview-789'),
      'repos/copse-dev/agent-pane/pulls/3456/reviews/789',
    )
    assert.equal(
      ownerReviewApiPath('https://github.com/another/repo/issues/2719#issuecomment-123'),
      null,
    )
  })

  it('verifies the live author, explicit approval, exact scope, expiry and decision date', () => {
    const entry = waived()
    assert.ok(entry.accountability?.waiver)
    const waiver = entry.accountability.waiver
    const evidence = decodeOwnerReviewEvidence({
      user: { login: 'Maintainer' },
      body: `Release waiver approved\nScope: ${waiver.scopeDigest}\nExpires: ${waiver.expiresOn}`,
      updated_at: '2026-10-04T09:12:00Z',
    })
    assert.ok(evidence)
    assert.deepEqual(ownerReviewErrors(entry, evidence), [])
    for (const patch of [
      { author: 'someone-else' },
      { approved: false },
      { body: 'Proposed release waiver' },
      { body: `Release waiver approved\nScope: ${waiver.scopeDigest}` },
      { body: `Release waiver approved\nExpires: ${waiver.expiresOn}` },
      { reviewedOn: '2026-10-03' },
    ])
      assert.ok(ownerReviewErrors(entry, { ...evidence, ...patch }).length > 0)
    const rejected = decodeOwnerReviewEvidence({
      user: { login: 'maintainer' },
      body: evidence.body,
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-10-04T09:12:00Z',
    })
    assert.ok(rejected)
    assert.equal(rejected.approved, false)
    assert.equal(
      decodeOwnerReviewEvidence({
        user: { login: 'maintainer' },
        body: 'text',
        updated_at: 'invalid',
      }),
      null,
    )
  })
})
