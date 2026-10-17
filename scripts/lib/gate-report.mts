import { createHash } from 'node:crypto'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from './safe-json.mts'
import {
  planSchema,
  outcomeSchema,
  classificationSchema,
  compareOutcomes,
} from './gate-evidence.mts'

const numeric = z.string().regex(/^\d+$/)
export const gateManifestSchema = z.array(
  z.object({
    runId: numeric,
    attempt: numeric,
    head: z.string().regex(/^[a-f0-9]{40}$/),
    createdAt: z.iso.datetime(),
    record: z.string().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    missingReason: z.string().optional(),
    classifications: classificationSchema.optional(),
  }),
)
const recordSchema = z.object({
  sourceRun: numeric,
  sourceAttempt: numeric,
  plan: planSchema.extend({
    event: z.string().optional(),
    baseRef: z.string().optional(),
    draft: z.boolean().optional(),
    labels: z.object({ ciFull: z.boolean(), updateScreenshots: z.boolean() }).optional(),
    inventory: z
      .object({ areas: z.array(z.object({ smoke: z.array(z.string()).nullable() })) })
      .optional(),
  }),
  outcomes: z.array(outcomeSchema),
})

type RunReport = {
  runId: string
  attempt: string
  createdAt: string
  status: 'missing' | 'invalid' | 'excluded' | 'complete' | 'incomplete'
  reason?: string
  mode?: string
  labelled?: boolean
  realFailures?: number
  estimatedSavedSpecMinutes?: number
} & Partial<ReturnType<typeof compareOutcomes>>

type Summary = {
  runs: number
  missing: number
  invalid: number
  excluded: number
  incomplete: number
  completeFullReplays: number
  completeSubsetControls: number
  knownRealFailures: number
  knownMissedRealFailures: number
  realFailures: number
  missedRealFailures: number
  missedRealFraction: number | null
  estimatedSavedSpecMinutes: number
}
type GateReport = {
  version: number
  gateChangeReady: boolean
  limitations: string[]
  totals: Summary
  full: Summary
  subset: Summary
  labelled: Summary
  unlabelled: Summary
  weeks: (Summary & { start: string })[]
  smoke: {
    spec: string
    passed: number
    observed: number
    missing: number
    firstAttemptPassRate: number | null
  }[]
  runs: RunReport[]
}

/** Offline, candidate-bound accounting. Never treats unavailable records as successful replays. */
export function buildGateReport(
  manifestText: string,
  readRecord: (path: string) => string,
): GateReport {
  const manifest = safeJsonParse(manifestText, decodeWithSchema(gateManifestSchema))
  if (!manifest) throw new Error('Invalid gate manifest')
  const latest = new Map<string, (typeof manifest)[number]>()
  const seen = new Set<string>()
  for (const entry of manifest) {
    const key = `${entry.runId}/${entry.attempt}`
    if (seen.has(key)) throw new Error(`Duplicate run attempt: ${key}`)
    seen.add(key)
    if (Number(entry.attempt) > Number(latest.get(entry.runId)?.attempt ?? 0))
      latest.set(entry.runId, entry)
  }
  const smoke = new Map<string, { passed: number; observed: number; missing: number }>()
  const runs = [...latest.values()].map((entry): RunReport => {
    const identity = { runId: entry.runId, attempt: entry.attempt, createdAt: entry.createdAt }
    if (!entry.record)
      return { ...identity, status: 'missing', reason: entry.missingReason ?? 'No durable record' }
    try {
      const bytes = readRecord(entry.record)
      if (!entry.sha256 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error('Record digest mismatch')
      const record = safeJsonParse(bytes, decodeWithSchema(recordSchema))
      if (!record) throw new Error('Invalid durable record')
      const { plan, outcomes } = record
      if (
        record.sourceRun !== entry.runId ||
        record.sourceAttempt !== entry.attempt ||
        plan.runId !== entry.runId ||
        (plan.head ?? plan.commit) !== entry.head ||
        Number(plan.runAttempt) > Number(entry.attempt)
      )
        throw new Error('Record provenance mismatch')
      const keys = new Set<string>()
      for (const row of outcomes) {
        const key = `${row.spec}/${row.runAttempt}/${String(row.attempt)}`
        if (
          keys.has(key) ||
          row.runId !== entry.runId ||
          row.commit !== plan.commit ||
          Number(row.runAttempt) > Number(entry.attempt) ||
          !plan.actual.specs.includes(row.spec)
        )
          throw new Error('Invalid outcome provenance or duplicate')
        keys.add(key)
      }
      const classifications = entry.classifications ?? []
      if (
        new Set(classifications.map((row) => row.spec)).size !== classifications.length ||
        classifications.some((row) => !plan.actual.specs.includes(row.spec))
      )
        throw new Error('Duplicate or unrelated classifications')
      if (
        plan.event !== 'pull_request' ||
        plan.baseRef !== 'main' ||
        plan.draft !== false ||
        !plan.labels
      )
        return {
          ...identity,
          status: 'excluded',
          reason: 'Not a recorded ready PR into main (or runtime context missing)',
        }
      const comparison = compareOutcomes(plan, outcomes, classifications, Number(entry.attempt))
      const current = outcomes.filter((row) => row.runAttempt === entry.attempt)
      const realFailures = classifications.filter(
        (row) =>
          row.classification === 'real' &&
          [1, 2].every((attempt) =>
            current.some(
              (outcome) =>
                outcome.spec === row.spec &&
                outcome.attempt === attempt &&
                outcome.outcome === 'failed',
            ),
          ),
      ).length
      const smokeSpecs = new Set(plan.inventory?.areas.flatMap((area) => area.smoke ?? []) ?? [])
      for (const spec of smokeSpecs) {
        const counts = smoke.get(spec) ?? { passed: 0, observed: 0, missing: 0 }
        const first = current.find((row) => row.spec === spec && row.attempt === 1)
        if (!first || first.outcome === 'running') counts.missing++
        else {
          counts.observed++
          if (first.outcome === 'passed') counts.passed++
        }
        smoke.set(spec, counts)
      }
      return {
        ...identity,
        status: comparison.classificationComplete ? 'complete' : 'incomplete',
        mode: plan.actual.mode,
        labelled: plan.labels.ciFull || plan.labels.updateScreenshots,
        realFailures,
        ...comparison,
        estimatedSavedSpecMinutes: plan.estimate.savedSpecMinutes,
      }
    } catch (error) {
      return {
        ...identity,
        status: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const summarize = (selected: typeof runs): Summary => {
    const complete = selected.filter((row) => row.status === 'complete')
    const real = complete.reduce((n, row) => n + (row.realFailures ?? 0), 0)
    const missed = complete.reduce((n, row) => n + (row.missedReal?.length ?? 0), 0)
    return {
      runs: selected.length,
      missing: selected.filter((row) => row.status === 'missing').length,
      invalid: selected.filter((row) => row.status === 'invalid').length,
      excluded: selected.filter((row) => row.status === 'excluded').length,
      incomplete: selected.filter((row) => row.status === 'incomplete').length,
      completeFullReplays: complete.filter((row) => row.mode === 'full').length,
      completeSubsetControls: complete.filter((row) => row.mode === 'subset').length,
      knownRealFailures: selected.reduce((n, row) => n + (row.realFailures ?? 0), 0),
      knownMissedRealFailures: selected.reduce((n, row) => n + (row.missedReal?.length ?? 0), 0),
      realFailures: real,
      missedRealFailures: missed,
      missedRealFraction: real ? missed / real : null,
      estimatedSavedSpecMinutes: complete.reduce(
        (n, row) => n + (row.estimatedSavedSpecMinutes ?? 0),
        0,
      ),
    }
  }
  const week = (date: string): string => {
    const d = new Date(date)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    return d.toISOString().slice(0, 10)
  }
  return {
    version: 1,
    gateChangeReady: false,
    limitations: [
      'Spec-minute estimates exclude setup, downloads, retries and queue time.',
      'Worker success is not proof that platform-skipped tests ran.',
      'Four-week live coverage, promotion comparisons and attestation require separate evidence.',
      'Missing runtime context and unclassified failures never qualify toward 300 full replays.',
    ],
    totals: summarize(runs),
    full: summarize(runs.filter((row) => row.mode === 'full')),
    subset: summarize(runs.filter((row) => row.mode === 'subset')),
    labelled: summarize(runs.filter((row) => row.labelled === true)),
    unlabelled: summarize(runs.filter((row) => row.labelled === false)),
    weeks: [...new Set(runs.map((row) => week(row.createdAt)))].sort().map((start) => ({
      start,
      ...summarize(runs.filter((row) => week(row.createdAt) === start)),
    })),
    smoke: [...smoke]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([spec, counts]) => ({
        spec,
        ...counts,
        firstAttemptPassRate: counts.observed ? counts.passed / counts.observed : null,
      })),
    runs,
  }
}

/** GitHub can replace details_url with its own check page; retain summary evidence links. */
export function gateEvidenceLinks(detailsUrl: string | null, summary: string | null): string[] {
  return [...(detailsUrl ? [detailsUrl] : []), ...(summary?.match(/https:\/\/[^\s<>]+/g) ?? [])]
}
