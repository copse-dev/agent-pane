import { z } from 'zod'
import { Lexer } from 'marked'
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

export const PLAN_STEP_EFFORTS = ['low', 'medium', 'high'] as const
export type PlanStepEffort = (typeof PLAN_STEP_EFFORTS)[number]

/** Structured step inside a plan revision (optional). */
export const planStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Other plan-step ids that must be complete before this step can start. */
  dependsOn: z.array(z.string().min(1)).optional(),
  /** Coarse sizing input for later model routing; it does not select a model. */
  effort: z.enum(PLAN_STEP_EFFORTS).optional(),
  /** Todo that records execution progress for this approved-plan step. */
  todoId: z.string().min(1).optional(),
  /** Observable artifact or behavior that discharges the step. */
  expectedOutput: z.string().min(1).optional(),
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
  supersedesPlanId: z.uuid().optional(),
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
  /** Exact passage at comment time, retained when later revisions move it. */
  quote: z.string().optional(),
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

/** Evidence is reported by the agent; an absent report never implies success. */
export const planCriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(['met', 'partial', 'unverified']),
  evidence: z.string().trim().min(1).max(10000),
})
export const planCompletionSchema = z.object({
  planId: z.string().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().min(1),
  reportedAt: z.number().int(),
  results: z.array(planCriterionResultSchema),
})
export type PlanCompletion = z.infer<typeof planCompletionSchema>
export const planStateSchema = z.object({
  meta: planMetaSchema,
  comments: z.array(planCommentSchema),
  approval: planApprovalSchema.nullable(),
  completion: planCompletionSchema.nullable(),
})
export type PlanState = z.infer<typeof planStateSchema>
export interface StoredThreadPlan extends PlanState {
  body: string
  /** Hash of the current body, including drafts. */
  contentHash: string
}
export interface PlanDraft {
  title: string
  body: string
}
export interface PlanCriterion {
  id: string
  label: string
}

export const REQUIRED_PLAN_SECTIONS = ['Goal', 'Constraints', 'Scope', 'Definition of done']

// A structural view of Marked's tokens keeps its extension index signature out
// of consumers. Only the built-in lexer is used; document bytes stay untouched.
interface PlanToken {
  type: string
  raw: string
  text?: string
  depth?: number
  tokens?: readonly PlanToken[]
  items?: readonly PlanToken[]
}

function tokenText(token: PlanToken): string {
  if (['space', 'html', 'def', 'hr', 'checkbox'].includes(token.type)) return ''
  if (token.type === 'br') return '\n'
  if (token.items) return token.items.map(tokenText).join('\n')
  if (token.tokens)
    return token.tokens
      .map(tokenText)
      .join(token.type === 'list_item' || token.type === 'blockquote' ? '\n' : '')
  return token.text ?? token.raw
}

function blockText(tokens: readonly PlanToken[]): string {
  return tokens
    .map(tokenText)
    .join('\n')
    .replace(/[ \t]*\r?\n[ \t\r\n]*/g, ' ')
    .trim()
}

function listCriteria(tokens: readonly PlanToken[]): string[] {
  return tokens.flatMap((token) => {
    // Only real list blocks become criteria. Quoted/fenced examples are prose.
    if (token.type !== 'list') return []
    return (token.items ?? []).flatMap((item) => {
      const children = item.tokens ?? []
      const label = blockText(children.filter((child) => child.type !== 'list'))
      return [...(label ? [label] : []), ...listCriteria(children)]
    })
  })
}

/** Shared interpretation for validation, agent context and completion evidence. */
export function parsePlanDocument(body: string): {
  sections: ReadonlyMap<string, string>
  criteria: PlanCriterion[]
} {
  const tokens: readonly PlanToken[] = Lexer.lex(body, { gfm: true })
  const sections = new Map<string, PlanToken[]>()
  let active: { depth: number; tokens: PlanToken[] } | null = null
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth !== undefined) {
      const text = tokenText(token).trim().toLowerCase()
      const label = REQUIRED_PLAN_SECTIONS.find((name) => name.toLowerCase() === text)
      if (label) {
        const content: PlanToken[] = []
        if (!sections.has(label)) sections.set(label, content)
        active = { depth: token.depth, tokens: content }
        continue
      }
      if (active && token.depth <= active.depth) active = null
    }
    active?.tokens.push(token)
  }
  return {
    sections: new Map([...sections].map(([label, content]) => [label, blockText(content)])),
    criteria: listCriteria(sections.get('Definition of done') ?? []).map((label, i) => ({
      id: `criterion-${String(i + 1)}`,
      label,
    })),
  }
}

/** IDs are stable within the immutable approved revision. */
export function planCriteria(body: string): PlanCriterion[] {
  return parsePlanDocument(body).criteria
}

/** User actions cross the preload boundary; execution profile is host-owned. */
export type PlanChange =
  | ({ action: 'create' } & PlanDraft)
  | ({ action: 'revise'; planId: string; revision: number } & PlanDraft)
  | {
      action: 'comment'
      planId: string
      revision: number
      body: string
      anchor: { start: number; end: number }
    }
  | { action: 'approve'; planId: string; revision: number; contentHash: string }
  | { action: 'abandon'; planId: string; revision: number }
