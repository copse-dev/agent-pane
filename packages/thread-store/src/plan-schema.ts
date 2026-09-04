import { z } from 'zod'
import type { ContentRef, HashFn } from './spine-schema.ts'

/**
 * On-disk Plan Mode artifacts under a thread directory (issue #1080, P1).
 *
 * Layout (resolved Open Q1 in docs/plans/plan-mode-and-rewind.md):
 *
 * ```
 * <threadId>/plans/<planId>/
 *   meta.json           # identity + status + current revision pointer
 *   revision-<n>.md     # human-readable plan body (markdown)
 *   comments.json       # inline comments keyed to revision + optional anchors
 *   approval.json       # present only after approve (revision + profile + hash)
 * ```
 *
 * Spine lifecycle lines (`type: "plan"`) live in `events.jsonl` and reference
 * revision files via {@link ContentRef}. This module is pure validation + path
 * helpers — no fs/Electron — so fixtures can validate without a store writer.
 */

/** Plan lifecycle statuses (binding contract in plan-mode-and-rewind.md). */
export const PLAN_STATUSES = ['draft', 'approved', 'superseded', 'abandoned'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const planStatusSchema = z.enum(PLAN_STATUSES)

/** Structured step inside a plan revision (optional). */
export const planStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})
export type PlanStep = z.infer<typeof planStepSchema>

/**
 * Logical revision record used by fixtures and future writers. On disk the
 * markdown `body` lives in `revision-<n>.md`; other fields may be mirrored in
 * `meta.json` / approval records.
 */
export const planRevisionRecordSchema = z.object({
  planId: z.string().min(1),
  revision: z.number().int().positive(),
  threadId: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  steps: z.array(planStepSchema).optional(),
  status: planStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Hex sha256 of `body` (integrity at approval time; optional while drafting). */
  contentHash: z.string().min(1).optional(),
  approvedAt: z.number().int().optional(),
  approvedRevision: z.number().int().positive().optional(),
  executionProfileId: z.string().min(1).optional(),
})
export type PlanRevisionRecord = z.infer<typeof planRevisionRecordSchema>

/** Durable plan pointer under `plans/<planId>/meta.json`. */
export const planMetaSchema = z.object({
  planId: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().min(1),
  status: planStatusSchema,
  currentRevision: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  approvedAt: z.number().int().optional(),
  approvedRevision: z.number().int().positive().optional(),
  executionProfileId: z.string().min(1).optional(),
  /** Content hash of the approved revision body when status is `approved`. */
  contentHash: z.string().min(1).optional(),
})
export type PlanMeta = z.infer<typeof planMetaSchema>

/** Inline comment on a plan revision (`comments.json` entries). */
export const planCommentSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  body: z.string().min(1),
  createdAt: z.number().int(),
  author: z.enum(['user', 'agent']).optional(),
  /** Optional character offsets into the revision markdown body. */
  anchor: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .refine((a) => a.end >= a.start, { message: 'anchor.end must be >= anchor.start' })
    .optional(),
})
export type PlanComment = z.infer<typeof planCommentSchema>

export const planCommentsFileSchema = z.object({
  comments: z.array(planCommentSchema),
})
export type PlanCommentsFile = z.infer<typeof planCommentsFileSchema>

/** Approval record written to `approval.json` when a revision is approved. */
export const planApprovalSchema = z.object({
  planId: z.string().min(1),
  approvedRevision: z.number().int().positive(),
  approvedAt: z.number().int(),
  executionProfileId: z.string().min(1),
  /** Hex sha256 of the approved revision body at approval time. */
  contentHash: z.string().min(1),
})
export type PlanApproval = z.infer<typeof planApprovalSchema>

export function planDir(planId: string): string {
  return `plans/${planId}`
}

export function planMetaPath(planId: string): string {
  return `${planDir(planId)}/meta.json`
}

export function planRevisionPath(planId: string, revision: number): string {
  return `${planDir(planId)}/revision-${String(revision)}.md`
}

export function planCommentsPath(planId: string): string {
  return `${planDir(planId)}/comments.json`
}

export function planApprovalPath(planId: string): string {
  return `${planDir(planId)}/approval.json`
}

/** Hex sha256 of a plan revision body (inject hash so callers stay Node-free). */
export function planBodyContentHash(body: string, hash: HashFn): string {
  return hash(body)
}

export function parsePlanMeta(raw: unknown): PlanMeta | null {
  const parsed = planMetaSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parsePlanRevisionRecord(raw: unknown): PlanRevisionRecord | null {
  const parsed = planRevisionRecordSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parsePlanCommentsFile(raw: unknown): PlanCommentsFile | null {
  const parsed = planCommentsFileSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parsePlanApproval(raw: unknown): PlanApproval | null {
  const parsed = planApprovalSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Thread-relative refs a plan spine line may keep alive across full saves. */
export function planArtifactRefs(artifact: ContentRef | undefined): string[] {
  return artifact ? [artifact.ref] : []
}
