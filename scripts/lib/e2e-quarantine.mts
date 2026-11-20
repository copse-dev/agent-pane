import { z } from 'zod'
import type { ExclusionRegistry } from './e2e-exclusions.mts'
import { outcomeSchema } from './gate-evidence.mts'

/**
 * The marker a quarantined spec carries when the CI config excludes it. In-spec
 * skips (`this.skip`, `describe.skip`) are for platform and environment gaps,
 * which a Linux nightly cannot run either, so only config-level exclusion makes
 * a spec eligible for the nightly quarantine run.
 */
export const QUARANTINE_MARKER = 'wdio.ci.conf.ts: exclude'

/** Consecutive passing nights after which a quarantined spec is a restore candidate. */
export const RESTORE_STREAK = 10

/** Nights retained in the rolling history; enough to show a streak well past RESTORE_STREAK. */
export const HISTORY_LIMIT = 60

/** Specs the nightly quarantine run executes, in registry order. */
export function quarantinedSpecs(registry: ExclusionRegistry): string[] {
  return registry.entries
    .filter((entry) => entry.category === 'quarantine' && entry.markers.includes(QUARANTINE_MARKER))
    .map((entry) => entry.spec)
}

const nightResultSchema = z.enum(['passed', 'failed', 'missing'])
export type NightResult = z.infer<typeof nightResultSchema>

export const quarantineHistorySchema = z.strictObject({
  version: z.literal(1),
  nights: z.array(
    z.strictObject({
      runId: z.string().min(1),
      runAttempt: z.string().min(1),
      date: z.iso.date(),
      commit: z.string().min(1),
      results: z.record(z.string(), nightResultSchema),
    }),
  ),
})
export type QuarantineHistory = z.infer<typeof quarantineHistorySchema>
export type QuarantineNight = QuarantineHistory['nights'][number]
type Outcome = z.infer<typeof outcomeSchema>

/**
 * One night's result per quarantined spec. The run has no shard retry, so only
 * attempt 1 counts. A spec whose worker never reported a final outcome (a crash
 * or a timeout leaves `running`) or never started is `missing`, which breaks a
 * streak exactly like a failure: a restore needs evidence that the spec passed.
 */
export function nightResults(
  specs: readonly string[],
  outcomes: readonly Outcome[],
): Record<string, NightResult> {
  const results: Record<string, NightResult> = {}
  for (const spec of specs) {
    const finals = outcomes.filter(
      (outcome) => outcome.spec === spec && outcome.attempt === 1 && outcome.outcome !== 'running',
    )
    results[spec] =
      finals.length === 0
        ? 'missing'
        : finals.every((outcome) => outcome.outcome === 'passed')
          ? 'passed'
          : 'failed'
  }
  return results
}

/** Append a night, replacing an earlier record of the same run, and keep the newest HISTORY_LIMIT. */
export function appendNight(
  history: QuarantineHistory | null,
  night: QuarantineNight,
): QuarantineHistory {
  const nights = (history?.nights ?? []).filter((previous) => previous.runId !== night.runId)
  return { version: 1, nights: [...nights, night].slice(-HISTORY_LIMIT) }
}

/**
 * Consecutive passing nights per spec, counted back from the newest night. A
 * night that did not record the spec (it was not quarantined yet, or the record
 * predates it) ends the streak, so a streak never overstates the evidence.
 */
export function passStreaks(
  history: QuarantineHistory,
  specs: readonly string[],
): Map<string, number> {
  const streaks = new Map<string, number>()
  for (const spec of specs) {
    let streak = 0
    for (const night of [...history.nights].reverse()) {
      if (night.results[spec] !== 'passed') break
      streak++
    }
    streaks.set(spec, streak)
  }
  return streaks
}
