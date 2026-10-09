import { createHash } from 'node:crypto'

export interface QuarantineAccountability {
  owner: string | null
  disposition: 'restore' | 'replace' | 'retire'
  nextStep: string
  waiver?: {
    reviewedBy: string
    reviewedOn: string
    expiresOn: string
    decisionUrl: string
    reason: string
    scopeDigest: string
  }
}

export interface ReleaseExclusion {
  spec: string
  category: 'quarantine' | 'external-service' | 'platform' | 'environment'
  reason: string
  coverage: string
  markers: string[]
  accountability?: QuarantineAccountability | undefined
}

export const MAX_QUARANTINE_WAIVER_DAYS = 14
const DAY_MS = 86_400_000
const PERSON = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const DECISION =
  /^https:\/\/github\.com\/copse-dev\/agent-pane\/(?:issues\/[1-9]\d*#issuecomment-\d+|pull\/[1-9]\d*#(?:issuecomment-\d+|pullrequestreview-\d+))$/

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (!Object.hasOwn(value, key)) return undefined
  const field: unknown = Reflect.get(value, key)
  return field
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null
}

/** Shared with the full registry schema; the release workflows need no install. */
export function decodeQuarantineAccountability(value: unknown): QuarantineAccountability | null {
  if (!exactKeys(value, ['owner', 'disposition', 'nextStep'], ['waiver'])) return null
  const owner = property(value, 'owner')
  const disposition = property(value, 'disposition')
  const nextStep = property(value, 'nextStep')
  if (owner !== null && (typeof owner !== 'string' || !PERSON.test(owner))) return null
  if (disposition !== 'restore' && disposition !== 'replace' && disposition !== 'retire')
    return null
  if (typeof nextStep !== 'string' || !nextStep.trim()) return null
  const rawWaiver = property(value, 'waiver')
  if (rawWaiver === undefined) return { owner, disposition, nextStep }
  if (
    !exactKeys(rawWaiver, [
      'reviewedBy',
      'reviewedOn',
      'expiresOn',
      'decisionUrl',
      'reason',
      'scopeDigest',
    ])
  )
    return null
  const reviewedBy = property(rawWaiver, 'reviewedBy')
  const reviewedOn = date(property(rawWaiver, 'reviewedOn'))
  const expiresOn = date(property(rawWaiver, 'expiresOn'))
  const decisionUrl = property(rawWaiver, 'decisionUrl')
  const reason = property(rawWaiver, 'reason')
  const scopeDigest = property(rawWaiver, 'scopeDigest')
  if (
    typeof reviewedBy !== 'string' ||
    !PERSON.test(reviewedBy) ||
    !reviewedOn ||
    !expiresOn ||
    typeof decisionUrl !== 'string' ||
    !DECISION.test(decisionUrl) ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    typeof scopeDigest !== 'string' ||
    !/^[a-f\d]{64}$/.test(scopeDigest)
  )
    return null
  return {
    owner,
    disposition,
    nextStep,
    waiver: { reviewedBy, reviewedOn, expiresOn, decisionUrl, reason, scopeDigest },
  }
}

/** Decode only the release-policy projection; ordinary CI validates the complete registry. */
export function decodeReleaseExclusions(value: unknown): ReleaseExclusion[] | null {
  if (!exactKeys(value, ['version', 'entries']) || property(value, 'version') !== 2) return null
  const entries = property(value, 'entries')
  if (!Array.isArray(entries)) return null
  const decoded: ReleaseExclusion[] = []
  for (const entry of entries) {
    const spec = property(entry, 'spec')
    const category = property(entry, 'category')
    const reason = property(entry, 'reason')
    const coverage = property(entry, 'coverage')
    const markers = property(entry, 'markers')
    if (
      typeof spec !== 'string' ||
      !/^tests\/e2e\/.+\.e2e\.ts$/.test(spec) ||
      (category !== 'quarantine' &&
        category !== 'external-service' &&
        category !== 'platform' &&
        category !== 'environment') ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      typeof coverage !== 'string' ||
      !coverage.trim() ||
      !Array.isArray(markers) ||
      markers.length === 0
    )
      return null
    const decodedMarkers: string[] = []
    for (const marker of markers) {
      if (typeof marker !== 'string' || !marker.trim()) return null
      decodedMarkers.push(marker)
    }
    const rawAccountability = property(entry, 'accountability')
    if (category === 'quarantine') {
      const accountability = decodeQuarantineAccountability(rawAccountability)
      if (!accountability) return null
      decoded.push({ spec, category, reason, coverage, markers: decodedMarkers, accountability })
    } else {
      if (rawAccountability !== undefined) return null
      decoded.push({ spec, category, reason, coverage, markers: decodedMarkers })
    }
  }
  return decoded
}

/** An approval cannot silently cover changed skip markers, rationale or compensating evidence. */
export function quarantineScopeDigest(entry: ReleaseExclusion): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        entry.spec,
        entry.category,
        entry.reason,
        entry.coverage,
        [...entry.markers].sort(),
      ]),
    )
    .digest('hex')
}

/** No waiver is granted by an owner assignment, disposition or review deadline. */
export function quarantineReleaseErrors(
  entries: readonly ReleaseExclusion[],
  today: string,
): string[] {
  if (!date(today)) throw new Error('Invalid release review date')
  const errors: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.spec)) errors.push(`Duplicate exclusion: ${entry.spec}`)
    seen.add(entry.spec)
    if (entry.category !== 'quarantine') continue
    const review = entry.accountability
    if (!review?.owner) errors.push(`Accountable person missing: ${entry.spec}`)
    const waiver = review?.waiver
    if (!waiver) {
      errors.push(
        `Unaccepted quarantine requires restoration or an owner-reviewed release waiver: ${entry.spec}`,
      )
      continue
    }
    if (waiver.reviewedBy.toLowerCase() !== review.owner?.toLowerCase())
      errors.push(`Waiver was not reviewed by its accountable person: ${entry.spec}`)
    if (waiver.reviewedOn > today) errors.push(`Waiver review is in the future: ${entry.spec}`)
    const days = (Date.parse(waiver.expiresOn) - Date.parse(waiver.reviewedOn)) / DAY_MS
    if (days <= 0 || days > MAX_QUARANTINE_WAIVER_DAYS)
      errors.push(
        `Waiver must expire within ${String(MAX_QUARANTINE_WAIVER_DAYS)} days after review: ${entry.spec}`,
      )
    if (waiver.expiresOn <= today) errors.push(`Release waiver expired: ${entry.spec}`)
    if (waiver.scopeDigest !== quarantineScopeDigest(entry))
      errors.push(`Waiver does not cover the current exclusion and evidence: ${entry.spec}`)
  }
  return errors
}

export interface OwnerReviewEvidence {
  author: string
  body: string
  reviewedOn: string
  approved: boolean
}

/** Resolve only repository issue comments or PR reviews, never arbitrary URLs. */
export function ownerReviewApiPath(url: string): string | null {
  if (!DECISION.test(url)) return null
  const comment = /#issuecomment-(\d+)$/.exec(url)
  if (comment) return `repos/copse-dev/agent-pane/issues/comments/${comment[1] ?? ''}`
  const review = /\/pull\/(\d+)#pullrequestreview-(\d+)$/.exec(url)
  return review
    ? `repos/copse-dev/agent-pane/pulls/${review[1] ?? ''}/reviews/${review[2] ?? ''}`
    : null
}

export function decodeOwnerReviewEvidence(value: unknown): OwnerReviewEvidence | null {
  const author = property(property(value, 'user'), 'login')
  const body = property(value, 'body')
  const state = property(value, 'state')
  const timestamp = property(value, state === undefined ? 'updated_at' : 'submitted_at')
  if (
    typeof author !== 'string' ||
    !PERSON.test(author) ||
    typeof body !== 'string' ||
    typeof timestamp !== 'string' ||
    !Number.isFinite(Date.parse(timestamp))
  )
    return null
  const reviewedOn = date(timestamp.slice(0, 10))
  if (!reviewedOn) return null
  return { author, body, reviewedOn, approved: state === undefined || state === 'APPROVED' }
}

/** Registry text alone cannot claim a person's approval. Check the live decision. */
export function ownerReviewErrors(
  entry: ReleaseExclusion,
  evidence: OwnerReviewEvidence,
): string[] {
  const waiver = entry.accountability?.waiver
  if (!waiver) return [`Release waiver missing: ${entry.spec}`]
  const errors: string[] = []
  if (evidence.author.toLowerCase() !== waiver.reviewedBy.toLowerCase())
    errors.push(`Live waiver decision is from a different person: ${entry.spec}`)
  if (!evidence.approved || !/^Release waiver approved\s*$/im.test(evidence.body))
    errors.push(`Live decision does not approve a release waiver: ${entry.spec}`)
  if (evidence.reviewedOn !== waiver.reviewedOn)
    errors.push(`Live waiver review date differs from its record: ${entry.spec}`)
  if (!evidence.body.split(/\r?\n/).some((line) => line.trim() === `Scope: ${waiver.scopeDigest}`))
    errors.push(`Live waiver decision does not identify this exclusion scope: ${entry.spec}`)
  if (!evidence.body.split(/\r?\n/).some((line) => line.trim() === `Expires: ${waiver.expiresOn}`))
    errors.push(`Live waiver decision does not identify this expiry: ${entry.spec}`)
  return errors
}
