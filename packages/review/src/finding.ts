// The finding: the unit of output of Copse Reviewer (docs/plans/copse-reviewer.md,
// §The core move). One schema is the whole contract — every shell (terminal
// renderer, app card, PR comment, exit code) is a projection of a list of these.
//
// Authored as zod so the TypeScript type and any published JSON Schema come from
// one declaration, the way `@copse/agent`'s headless contract does it. Untrusted
// findings (a JSON file on disk, a CI artefact) enter through `decodeFinding`.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { memberOf } from '@copse/std/member-of.ts'

/**
 * Binding decision B4: bugs and regressions only. No `docs`, no style. A lint
 * failure is "the linter's job" (§The quality bar) — Stage 0 reports it as a
 * failed check, never as a finding.
 */
export const FINDING_CLASSES = [
  'build',
  'type',
  'test',
  'contract',
  'security',
  'concurrency',
  'resource',
  'api-compat',
] as const
export type FindingClass = (typeof FINDING_CLASSES)[number]
export const isFindingClass = memberOf(FINDING_CLASSES)

export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_CONFIDENCES = ['low', 'medium', 'high'] as const
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number]

export const VERDICT_STATUSES = ['confirmed', 'refuted', 'unverified'] as const
export type VerdictStatus = (typeof VERDICT_STATUSES)[number]

/** Which checkout a command ran in. */
export const CHECKOUT_TARGETS = ['base', 'head'] as const
export type CheckoutTarget = (typeof CHECKOUT_TARGETS)[number]

export const findingAnchorSchema = z.object({
  /** Repo-relative, forward-slashed. */
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** Git blob hash of the file the anchor was computed against, when known. */
  blobHash: z.string().min(1).optional(),
})
export type FindingAnchor = z.infer<typeof findingAnchorSchema>

/** Who raised, corroborated or challenged a finding. */
export const reviewerRefSchema = z.object({
  kind: z.enum(['stage0', 'model']),
  /** `stage0` for the ground stage; a model id for a reviewer or challenger. */
  id: z.string().min(1),
  /** The scoped brief a model reviewer ran under (Stage 2). */
  lens: z.string().min(1).optional(),
})
export type ReviewerRef = z.infer<typeof reviewerRefSchema>

export const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    /** The argv that ran, shell-quoted for display. */
    command: z.string().min(1),
    target: z.enum(CHECKOUT_TARGETS),
    /** `null` when the process was killed (timeout) rather than exiting. */
    exitCode: z.number().int().nullable(),
    /** Capped, secret-scrubbed tail of the interleaved output. */
    excerpt: z.string(),
  }),
  z.object({
    kind: z.literal('reproducer'),
    testPath: z.string().min(1),
    failsOnHead: z.boolean(),
    passesOnBase: z.boolean(),
  }),
  z.object({
    kind: z.literal('citation'),
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
])
export type Evidence = z.infer<typeof evidenceSchema>

export const findingSchema = z.object({
  /** Content-derived; see {@link findingId}. */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  anchor: findingAnchorSchema,
  /** One sentence, falsifiable. */
  claim: z.string().min(1),
  class: z.enum(FINDING_CLASSES),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.enum(FINDING_CONFIDENCES),
  provenance: z.object({
    raisedBy: z.array(reviewerRefSchema).min(1),
    corroboratedBy: z.array(reviewerRefSchema),
    challengedBy: z.array(reviewerRefSchema),
  }),
  evidence: z.array(evidenceSchema),
  verdict: z.object({
    status: z.enum(VERDICT_STATUSES),
    reason: z.string().min(1),
  }),
  /** Optional minimal patch a human applies. Never applied automatically. */
  remedy: z.object({ patch: z.string().min(1) }).optional(),
})
export type Finding = z.infer<typeof findingSchema>

export const decodeFinding = decodeWithSchema(findingSchema)
export const decodeFindings = decodeWithSchema(z.array(findingSchema))

/**
 * Canonical form of a claim for identity purposes: case-folded, whitespace
 * collapsed, trailing punctuation dropped. Two reviewers phrasing the same
 * claim with different spacing or a final full stop produce the same identity.
 */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
}

/** Canonical form of anchored source: per-line trimmed, blank lines dropped. */
export function normalizeAnchoredText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

export interface FindingIdentityInput {
  readonly class: FindingClass
  readonly path: string
  /** The source text the anchor covers — NOT its line numbers. */
  readonly anchoredText: string
  readonly claim: string
}

/**
 * A stable id derived from the *content* of the anchored lines plus the
 * normalised claim, so it survives a rebase or a reformat that moves the lines
 * (P2). Sixteen hex characters of SHA-256: short enough to quote, wide enough
 * that a collision inside one review is not a practical concern.
 */
export function findingId(input: FindingIdentityInput): string {
  const hash = createHash('sha256')
  hash.update(
    [
      input.class,
      input.path.replace(/\\/g, '/'),
      normalizeAnchoredText(input.anchoredText),
      normalizeClaim(input.claim),
    ].join('\n\u0000'),
  )
  return hash.digest('hex').slice(0, 16)
}
