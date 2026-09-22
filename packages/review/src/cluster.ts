// Stage 3 — Merge (docs/plans/copse-reviewer.md, §Pipeline; problem P2).
//
// Two candidates are the same finding when their anchors overlap and their
// claims are equivalent. Anchors overlap with a little slack, because two
// reviewers point at the same bug from adjacent lines; claims are equivalent
// when their content words mostly coincide. Corroboration is recorded, never
// collapsed into a score here — ranking is Stage 5's job.
//
// This is the starting proposal the plan names, tuned by hand on the tests
// below rather than on the corpus P2 asks for; the thresholds are exported so
// `bench:review` can move them with evidence.
import { normalizeClaim, type Finding, type ReviewerRef } from './finding.ts'

/** Lines of slack either side of an anchor when testing overlap. */
export const ANCHOR_SLACK_LINES = 3
/** Jaccard similarity of content words above which two claims are one claim. */
export const CLAIM_SIMILARITY_THRESHOLD = 0.34
/** Minimum shared content words for the containment fallback. */
export const CLAIM_CONTAINMENT_MIN_SHARED = 4
/** Share of the shorter claim that must occur in the longer claim. */
export const CLAIM_CONTAINMENT_THRESHOLD = 0.45

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'of',
  'to',
  'in',
  'on',
  'for',
  'and',
  'or',
  'not',
  'no',
  'with',
  'without',
  'as',
  'at',
  'by',
  'from',
  'when',
  'if',
  'then',
  'than',
  'so',
  'but',
  'into',
  'which',
  'will',
  'can',
  'does',
  'do',
  'did',
  'has',
  'have',
  'had',
  'never',
  'always',
  'instead',
  'now',
  'still',
])

/** The content words of a claim: normalised, de-stopworded, lightly stemmed. */
export function claimTokens(claim: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of normalizeClaim(claim).split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    // Crude stemming so "returns" and "return", "callers" and "caller" meet.
    const token = raw.replace(/(ing|ed|es|s)$/, '')
    if (token.length >= 2) tokens.add(token)
  }
  return tokens
}

export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a)
  const tb = claimTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared++
  return shared / (ta.size + tb.size - shared)
}

/**
 * A concise claim is often wholly contained in a more explanatory one even
 * when their Jaccard score is low. Require both enough shared words and a
 * substantial share of the shorter claim so generic review phrasing cannot
 * merge otherwise distinct defects.
 */
export function claimContainment(a: string, b: string): number {
  const ta = claimTokens(a)
  const tb = claimTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared++
  if (shared < CLAIM_CONTAINMENT_MIN_SHARED) return 0
  return shared / Math.min(ta.size, tb.size)
}

function anchorsOverlap(a: Finding, b: Finding): boolean {
  if (a.anchor.path !== b.anchor.path) return false
  const aStart = (a.anchor.startLine ?? 0) - ANCHOR_SLACK_LINES
  const aEnd = (a.anchor.endLine ?? a.anchor.startLine ?? 0) + ANCHOR_SLACK_LINES
  const bStart = b.anchor.startLine ?? 0
  const bEnd = b.anchor.endLine ?? bStart
  return aStart <= bEnd && bStart <= aEnd
}

/** Whether two findings are one finding. Exported so the rule is testable on its own. */
export function sameFinding(a: Finding, b: Finding): boolean {
  if (a.id === b.id) return true
  if (a.class !== b.class || !anchorsOverlap(a, b)) return false
  return (
    claimSimilarity(a.claim, b.claim) >= CLAIM_SIMILARITY_THRESHOLD ||
    claimContainment(a.claim, b.claim) >= CLAIM_CONTAINMENT_THRESHOLD
  )
}

function refKey(ref: ReviewerRef): string {
  return `${ref.kind}:${ref.id}:${ref.lens ?? ''}`
}

/**
 * Cluster findings into canonical ones. The first finding of a cluster (in
 * input order — callers put Stage 0's confirmed findings first) keeps its
 * identity, anchor, claim and verdict; every later member's raisers become
 * corroborators and its non-citation evidence is carried along. Its anchor
 * widens to cover every member, so a corroborated finding points at the whole
 * region the reviewers disagreed about.
 */
export function clusterFindings(findings: readonly Finding[]): Finding[] {
  const clusters: Finding[] = []
  for (const finding of findings) {
    const index = clusters.findIndex((canonical) => sameFinding(canonical, finding))
    if (index === -1) {
      clusters.push(finding)
      continue
    }
    const canonical = clusters[index]
    if (canonical === undefined) continue
    const known = new Set(
      [...canonical.provenance.raisedBy, ...canonical.provenance.corroboratedBy].map(refKey),
    )
    const corroboratedBy = [
      ...canonical.provenance.corroboratedBy,
      ...finding.provenance.raisedBy.filter((ref) => !known.has(refKey(ref))),
    ]
    const startLine =
      canonical.anchor.startLine === undefined || finding.anchor.startLine === undefined
        ? canonical.anchor.startLine
        : Math.min(canonical.anchor.startLine, finding.anchor.startLine)
    const endLine =
      canonical.anchor.endLine === undefined || finding.anchor.endLine === undefined
        ? canonical.anchor.endLine
        : Math.max(canonical.anchor.endLine, finding.anchor.endLine)
    clusters[index] = {
      ...canonical,
      anchor: {
        ...canonical.anchor,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
      },
      provenance: { ...canonical.provenance, corroboratedBy },
      evidence: [
        ...canonical.evidence,
        ...finding.evidence.filter((evidence) => evidence.kind !== 'citation'),
      ],
    }
  }
  return clusters
}
