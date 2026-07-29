/**
 * Shared zod schemas for the JSON `gh` hands back.
 *
 * These were defined inline in each consuming module, which meant three
 * independent descriptions of the same `gh pr view --json` payload (plus four
 * copies of the null-tolerant field helpers) that could drift from each other
 * silently. One definition per payload shape, with the TS types derived via
 * `z.infer`, so the type and the check cannot disagree.
 *
 * Only the shapes with more than one consumer live here. Schemas used by a
 * single module stay next to their call site.
 */
import { z } from 'zod'

/**
 * `gh` emits `null` for absent fields rather than omitting them, so every
 * optional scalar folds `null` into `undefined` before validating.
 */
export const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
)
export const optionalNumber = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().optional(),
)
export const optionalAuthorSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.object({ login: optionalString }).optional(),
)

/**
 * The union of every `gh pr view` / `gh pr list` field the app reads. Consumers
 * that need a subset just don't read the rest — a single superset keeps the
 * three former copies from drifting. Every field is optional because which ones
 * `gh` returns depends on the `--json` field list the caller passed.
 */
export const ghPrViewSchema = z.object({
  state: optionalString,
  number: optionalNumber,
  title: optionalString,
  url: optionalString,
  body: optionalString,
  headRefName: optionalString,
  baseRefName: optionalString,
  baseRefOid: optionalString,
  headRefOid: optionalString,
  author: optionalAuthorSchema,
  mergeable: optionalString,
  mergeStateStatus: optionalString,
  additions: optionalNumber,
  deletions: optionalNumber,
  changedFiles: optionalNumber,
  createdAt: optionalString,
  updatedAt: optionalString,
  isDraft: z.boolean().optional(),
  reviewDecision: optionalString,
  autoMergeRequest: z.object({ enabledAt: optionalString }).nullable().optional(),
  statusCheckRollup: z
    .array(
      z.object({
        __typename: optionalString,
        name: optionalString,
        context: optionalString,
        status: optionalString,
        conclusion: optionalString,
        state: optionalString,
        detailsUrl: optionalString,
      }),
    )
    .optional(),
  files: z
    .array(
      z.object({
        path: optionalString,
        additions: optionalNumber,
        deletions: optionalNumber,
        changeType: optionalString,
      }),
    )
    .optional(),
})

export type GhPrView = z.infer<typeof ghPrViewSchema>
/** The rollup array on its own — the shape `rollupToCiChecks` consumes. */
export type GhStatusCheckRollup = GhPrView['statusCheckRollup']

export const ghPrViewListSchema = z.array(ghPrViewSchema)
