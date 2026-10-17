import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'
const spec = z.string().regex(/^tests\/e2e\/[\w-]+\.e2e\.ts$/)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const numeric = z.string().regex(/^\d+$/)
export const planSchema = z
  .object({
    version: z.literal(1),
    shadowAvailable: z.boolean().optional(),
    runId: numeric,
    runAttempt: numeric,
    commit: sha,
    head: sha.nullable(),
    actual: z
      .object({
        mode: z.enum(['full', 'subset', 'skip']),
        specs: z.array(spec).max(2000),
        shards: z.number().int().min(0).max(8),
      })
      .loose(),
    proposed: z
      .object({
        mode: z.enum(['full', 'subset', 'skip']),
        specs: z.array(spec).max(2000),
        count: z.number().int().min(0),
        shards: z.number().int().min(0).max(8),
      })
      .loose(),
    estimate: z.object({ savedSpecMinutes: z.number() }).loose(),
  })
  .loose()
export const outcomeSchema = z.object({
  version: z.literal(1),
  spec,
  attempt: z.number().int().min(1).max(2),
  outcome: z.enum(['running', 'passed', 'failed']),
  exitCode: z.number().int().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  failureClass: z.enum(['unclassified']).nullable(),
  runId: numeric,
  runAttempt: numeric,
  shard: numeric,
  commit: sha,
})
export const classificationSchema = z.array(
  z.object({
    spec,
    classification: z.enum(['real', 'not-real']),
    evidence: z.url(),
  }),
)
export function parseGatePlan(text: string): z.infer<typeof planSchema> {
  const value = safeJsonParse(text, decodeWithSchema(planSchema))
  if (!value) throw new Error('Invalid gate plan')
  return value
}
export function parseOutcome(text: string): z.infer<typeof outcomeSchema> {
  const value = safeJsonParse(text, decodeWithSchema(outcomeSchema))
  if (!value) throw new Error('Invalid spec outcome')
  return value
}
export function compareOutcomes(
  plan: z.infer<typeof planSchema>,
  outcomes: z.infer<typeof outcomeSchema>[],
  classifications: z.infer<typeof classificationSchema> = [],
  sourceAttempt: number = Number(plan.runAttempt),
): {
  missedReal: string[]
  unclassified: string[]
  retriedPass: string[]
  incomplete: string[]
  classificationComplete: boolean
} {
  const real = new Set(
    classifications.filter((row) => row.classification === 'real').map((row) => row.spec),
  )
  const notReal = new Set(
    classifications.filter((row) => row.classification === 'not-real').map((row) => row.spec),
  )
  const missedReal: string[] = [],
    unclassified: string[] = [],
    retriedPass: string[] = [],
    incomplete: string[] = []
  // Without trusted job-attempt metadata, an older pass cannot distinguish an
  // untouched successful shard from a rerun that never reached this spec.
  const latest = Math.max(sourceAttempt, ...outcomes.map((row) => Number(row.runAttempt)))
  for (const path of plan.actual.specs) {
    const observations = outcomes.filter((row) => row.spec === path)
    const rows = observations.filter((row) => Number(row.runAttempt) === latest)
    if (!rows.length || rows.some((row) => row.outcome === 'running')) incomplete.push(path)
    if (!rows.some((row) => row.outcome === 'failed')) continue
    if (rows.some((row) => row.attempt === 2 && row.outcome === 'passed')) {
      retriedPass.push(path)
      continue
    }
    const repeated = [1, 2].every((attempt) =>
      rows.some((row) => row.attempt === attempt && row.outcome === 'failed'),
    )
    if (repeated && real.has(path)) {
      if (!plan.proposed.specs.includes(path)) missedReal.push(path)
    } else if (!notReal.has(path)) unclassified.push(path)
  }
  return {
    missedReal,
    unclassified,
    retriedPass,
    incomplete,
    classificationComplete:
      incomplete.length === 0 && unclassified.length === 0 && plan.shadowAvailable !== false,
  }
}
