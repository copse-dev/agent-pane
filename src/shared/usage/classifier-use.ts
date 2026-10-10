import { memberOf } from '@copse/std/member-of.ts'
import type { DecisionEvent } from '@shared/threads/decision-log.ts'

/**
 * Decision-log `kind` of a classifier-call line: one per screening attempt.
 * Distinct from the permission-oriented `classification` lines, which record a
 * verdict the gate acted on; counting only this kind means a screening that
 * produced both is reported once.
 */
export const CLASSIFIER_CALL_KIND = 'classifier-call'

/** What a classifier screened. */
export const CLASSIFIER_SUBJECTS = ['shell-scope', 'shell-tier', 'terminal-read'] as const
export type ClassifierSubject = (typeof CLASSIFIER_SUBJECTS)[number]

/** Label for the user-facing row, e.g. "Shell guard". */
export const CLASSIFIER_SUBJECT_LABELS: Record<ClassifierSubject, string> = {
  'shell-scope': 'Shell guard',
  'shell-tier': 'Shell approval tier',
  'terminal-read': 'Terminal read screen',
}

export interface ClassifierVerdictCount {
  /** The verdict the classifier gave: `sandbox`, `external`, `safe`, a tier name, … */
  label: string
  count: number
}

/** One screened subject on one engine within a thread. */
export interface ClassifierUseRow {
  subject: ClassifierSubject
  /** The model or classifier connection that answered, e.g. `Kev 4B`. */
  engine: string
  calls: number
  /** Verdict tallies, most frequent first. */
  verdicts: ClassifierVerdictCount[]
  /** Calls that produced no usable verdict (unavailable, timed out, unparseable). */
  noVerdict: number
  /** Mean time to answer across the calls that reported one; null when none did. */
  averageLatencyMs: number | null
  inputTokens: number
  outputTokens: number
}

/** What the classifiers did for one thread. */
export interface ThreadClassifierUse {
  /** Screening attempts across every row. */
  calls: number
  /** Busiest first. */
  rows: ClassifierUseRow[]
}

const isClassifierSubject = memberOf(CLASSIFIER_SUBJECTS)

interface Tally {
  row: Omit<ClassifierUseRow, 'verdicts' | 'averageLatencyMs'>
  verdicts: Map<string, number>
  latencyTotalMs: number
  latencySamples: number
}

/**
 * Fold a thread's decision-log lines into per-subject, per-engine classifier use.
 * Lines of any other kind, and classifier-call lines for a subject this build
 * does not know, are ignored so a log written by a newer build still loads.
 */
export function summarizeClassifierUse(events: readonly DecisionEvent[]): ThreadClassifierUse {
  const tallies = new Map<string, Tally>()
  for (const event of events) {
    if (event.kind !== CLASSIFIER_CALL_KIND || !isClassifierSubject(event.subject)) continue
    const engine = event.source ?? 'unknown'
    const key = `${event.subject}\u0000${engine}`
    let tally = tallies.get(key)
    if (!tally) {
      tally = {
        row: {
          subject: event.subject,
          engine,
          calls: 0,
          noVerdict: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        verdicts: new Map(),
        latencyTotalMs: 0,
        latencySamples: 0,
      }
      tallies.set(key, tally)
    }
    tally.row.calls += 1
    if (event.scope === undefined) tally.row.noVerdict += 1
    else tally.verdicts.set(event.scope, (tally.verdicts.get(event.scope) ?? 0) + 1)
    if (event.latencyMs !== undefined) {
      tally.latencyTotalMs += event.latencyMs
      tally.latencySamples += 1
    }
    tally.row.inputTokens += event.inputTokens ?? 0
    tally.row.outputTokens += event.outputTokens ?? 0
  }

  const rows = [...tallies.values()]
    .map((tally): ClassifierUseRow => ({
      ...tally.row,
      verdicts: [...tally.verdicts]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      averageLatencyMs:
        tally.latencySamples > 0 ? tally.latencyTotalMs / tally.latencySamples : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.subject.localeCompare(b.subject))
  return { calls: rows.reduce((sum, row) => sum + row.calls, 0), rows }
}
