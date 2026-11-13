import { z } from 'zod'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const targetSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive(),
  headSha: sha,
  baseSha: sha,
})
const actorSchema = z.enum(['agent', 'user', 'command_runner', 'ci'])
const requirementSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  actor: actorSchema,
})
const receiptSchema = z.object({
  requirement: z.string().min(1),
  target: targetSchema,
  checkedSha: sha,
  // Stable check/provider identity. Distinct sources never supersede each other.
  source: z.string().min(1),
  // Workflow run number, then check-run sequence within that run. Older snapshot
  // collectors have one generation; their sequence ordering remains unchanged.
  generation: z.number().int().nonnegative().default(0),
  sequence: z.number().int().nonnegative(),
  outcome: z.enum(['passed', 'failed', 'pending', 'skipped', 'unknown']),
  detail: z.string(),
  url: z.string().nullable(),
})

export const readinessSnapshotSchema = z.object({
  target: targetSchema,
  confirmedTarget: targetSchema.nullable(),
  observedAt: z.number().int().nonnegative(),
  complete: z.boolean(),
  problems: z.array(z.string()),
  requirements: z.array(requirementSchema),
  receipts: z.array(receiptSchema),
})
export type ReadinessTarget = z.infer<typeof targetSchema>
export type ReadinessSnapshot = z.infer<typeof readinessSnapshotSchema>
export type ReadinessReceipt = z.infer<typeof receiptSchema>
export type ReadinessState = 'ready' | 'blocked' | 'waiting' | 'unknown'

interface RequirementDecision {
  key: string
  label: string
  state: ReadinessState
  actor: z.infer<typeof actorSchema>
  reason: string
  evidence: ReadinessReceipt[]
}
export interface ReadinessDecision {
  // This is evidence about declared requirements, never permission to merge.
  target: ReadinessTarget
  observedAt: number
  state: ReadinessState
  problems: string[]
  requirements: RequirementDecision[]
  historical: ReadinessReceipt[]
  nextActor: z.infer<typeof actorSchema> | null
}

export function sameReadinessTarget(a: ReadinessTarget, b: ReadinessTarget): boolean {
  return (
    a.repository.toLowerCase() === b.repository.toLowerCase() &&
    a.number === b.number &&
    a.headSha === b.headSha &&
    a.baseSha === b.baseSha
  )
}

function aggregate(states: ReadinessState[]): ReadinessState {
  if (states.includes('blocked')) return 'blocked'
  if (states.includes('unknown')) return 'unknown'
  if (states.includes('waiting')) return 'waiting'
  return 'ready'
}

/** Pure, clock-injected decision. Every receipt must describe the same PR/head/base.
 * The collector owns completeness and the inventory of required evidence. Missing
 * inventory is not an empty green result. Snapshot files are data, not attestations.
 */
export function assessPrReadiness(
  snapshot: ReadinessSnapshot,
  now: number,
  maxAgeMs = 5 * 60_000,
): ReadinessDecision {
  const problems = [...snapshot.problems]
  if (!snapshot.complete) problems.push('The observation or requirement inventory is incomplete.')
  if (!snapshot.confirmedTarget || !sameReadinessTarget(snapshot.target, snapshot.confirmedTarget))
    problems.push('The PR head/base was not confirmed unchanged after observation.')
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    snapshot.observedAt > now ||
    now - snapshot.observedAt > maxAgeMs
  )
    problems.push('The observation is expired or has an invalid timestamp. Refresh it.')
  if (snapshot.requirements.length === 0) problems.push('No requirement inventory was supplied.')
  if (new Set(snapshot.requirements.map((item) => item.key)).size !== snapshot.requirements.length)
    problems.push('The requirement inventory contains duplicate identities.')

  const historical = snapshot.receipts.filter(
    (receipt) =>
      !sameReadinessTarget(receipt.target, snapshot.target) ||
      receipt.checkedSha !== snapshot.target.headSha,
  )
  const current = snapshot.receipts.filter(
    (receipt) =>
      sameReadinessTarget(receipt.target, snapshot.target) &&
      receipt.checkedSha === snapshot.target.headSha,
  )
  const requirements = snapshot.requirements.map((requirement): RequirementDecision => {
    const latest = new Map<string, ReadinessReceipt[]>()
    for (const receipt of current.filter((item) => item.requirement === requirement.key)) {
      const prior = latest.get(receipt.source)
      const previous = prior?.[0]
      if (
        previous === undefined ||
        receipt.generation > previous.generation ||
        (receipt.generation === previous.generation && receipt.sequence > previous.sequence)
      )
        latest.set(receipt.source, [receipt])
      else if (receipt.generation === previous.generation && receipt.sequence === previous.sequence)
        prior?.push(receipt)
    }
    const evidence = [...latest.values()].flat()
    let state: ReadinessState
    let reason: string
    if (evidence.length === 0) {
      state = 'unknown'
      reason = 'No result covers this PR head and base.'
    } else if (
      [...latest.values()].some((items) => new Set(items.map((item) => item.outcome)).size > 1)
    ) {
      state = 'unknown'
      reason = 'Conflicting results have the same source, generation and sequence.'
    } else if (evidence.some((item) => item.outcome === 'failed')) {
      state = 'blocked'
      reason = 'A current result failed.'
    } else if (evidence.some((item) => item.outcome === 'unknown' || item.outcome === 'skipped')) {
      state = 'unknown'
      reason = 'A skipped or unknown result does not prove this requirement passed.'
    } else if (evidence.some((item) => item.outcome === 'pending')) {
      state = 'waiting'
      reason = 'A current result is still pending.'
    } else {
      state = 'ready'
      reason = 'All observed sources for this requirement passed.'
    }
    return { ...requirement, state, reason, evidence }
  })
  const state = aggregate([
    ...requirements.map((item) => item.state),
    ...(problems.length > 0 ? ['unknown' as const] : []),
  ])
  return {
    target: snapshot.target,
    observedAt: snapshot.observedAt,
    state,
    problems,
    requirements,
    historical,
    nextActor:
      problems.length > 0
        ? 'agent'
        : (requirements.find((item) => item.state === state && item.state !== 'ready')?.actor ??
          null),
  }
}
