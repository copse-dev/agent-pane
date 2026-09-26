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
import { createHash } from 'node:crypto'
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
    const suffix = raw.match(/(ing|ed)$/)?.[0]
    let token = raw.replace(/(ing|ed|es|s)$/, '')
    // English doubles a final consonant before -ing/-ed (drop -> dropping,
    // omit -> omitted). Keep l/s/z doubles because they belong to roots such
    // as fill, miss and buzz rather than to the suffix spelling rule.
    if (suffix !== undefined && /([^aeioulsz])\1$/.test(token)) token = token.slice(0, -1)
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

/**
 * Line ranges overlap within `slack`; a range without lines covers the whole
 * file. Shared with `eval.ts`, which matches a finding to a known defect the
 * same way Stage 3 clusters.
 */
export function anchorsOverlap(
  a: { readonly startLine?: number | undefined; readonly endLine?: number | undefined },
  b: { readonly startLine?: number | undefined; readonly endLine?: number | undefined },
  slack = ANCHOR_SLACK_LINES,
): boolean {
  if (a.startLine === undefined || b.startLine === undefined) return true
  const aEnd = a.endLine ?? a.startLine
  const bEnd = b.endLine ?? b.startLine
  return a.startLine <= bEnd + slack && b.startLine <= aEnd + slack
}

/**
 * Whether two findings are one finding. Exported so the rule is testable on its own.
 *
 * An equal id means equal class, path, anchored text and claim — but not equal
 * lines: the id deliberately omits them, so the same diagnostic on two identical
 * lines of one file shares an id. The anchors must still overlap.
 */
export function sameFinding(a: Finding, b: Finding): boolean {
  if (a.anchor.path !== b.anchor.path || !anchorsOverlap(a.anchor, b.anchor)) return false
  if (a.id === b.id) return true
  if (a.class !== b.class) return false
  return (
    claimSimilarity(a.claim, b.claim) >= CLAIM_SIMILARITY_THRESHOLD ||
    claimContainment(a.claim, b.claim) >= CLAIM_CONTAINMENT_THRESHOLD
  )
}

/**
 * A distinct id for the `occurrence`th separate finding that minted `id`, so
 * everything keyed by id downstream (Stage 4's verdicts, SARIF fingerprints)
 * keeps the two apart. Deterministic in input order.
 */
function occurrenceId(id: string, occurrence: number): string {
  return createHash('sha256')
    .update(`${id}\n\u0000${String(occurrence)}`)
    .digest('hex')
    .slice(0, 16)
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
      let id = finding.id
      for (let occurrence = 1; clusters.some((canonical) => canonical.id === id); occurrence++) {
        id = occurrenceId(finding.id, occurrence)
      }
      clusters.push(id === finding.id ? finding : { ...finding, id })
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
      canonical.anchor.startLine === undefined || finding.anchor.startLine === undefined
        ? canonical.anchor.endLine
        : Math.max(
            canonical.anchor.endLine ?? canonical.anchor.startLine,
            finding.anchor.endLine ?? finding.anchor.startLine,
          )
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
