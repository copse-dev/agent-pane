// The Stage 0 report as a decoder. Inside one process the report is a value
// `runStage0Checks` returned; between the CI shell's two jobs it is a file an
// artefact carried from a runner that executed the pull request's own code
// (§Execution isolation, "Backend per shell — CI"). That file is untrusted
// input to the job holding the model key: it is validated here, shape by
// shape, before a single field of it reaches a model or a comment.
import { z } from 'zod'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { testFailureReportSchema } from './test-failures.ts'
import { findingSchema } from './finding.ts'
import { CHECK_KINDS, REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { STAGE0_REPORT_VERSION, type Stage0Report } from './stage0.ts'
import { inconclusiveCheckReason } from './check-failure.ts'

const checkKindSchema = z.enum(CHECK_KINDS)
const targetSchema = z.enum(['base', 'head'])
const argvSchema = z.tuple([z.string().min(1)], z.string())

const checkRunSchema = z
  .object({
    testFailures: testFailureReportSchema.optional(),
    kind: checkKindSchema,
    target: targetSchema,
    argv: z.array(z.string()),
    status: z.enum(['passed', 'failed', 'timed-out']),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable().optional(),
    durationMs: z.number(),
    output: z.string(),
    outputTruncated: z.boolean(),
  })
  .transform(({ testFailures, signal, ...run }) => ({
    ...run,
    ...(signal === undefined ? {} : { signal }),
    ...(testFailures === undefined ? {} : { testFailures }),
  }))

const checkOutcomeSchema = z
  .object({
    kind: checkKindSchema,
    verdict: z.enum(['clean', 'regressed', 'failing-on-base', 'fixed', 'undetermined', 'not-run']),
    head: checkRunSchema.nullable(),
    base: checkRunSchema.nullable(),
    headConfirmation: checkRunSchema.optional(),
    reason: z.string().optional(),
  })
  // `reason` is present or absent, never `undefined` (exactOptionalPropertyTypes).
  .transform(({ reason, headConfirmation, ...outcome }) => ({
    ...outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(headConfirmation === undefined ? {} : { headConfirmation }),
  }))

const projectSchema = z.union([
  z.object({
    ecosystem: z.enum(['typescript-pnpm', 'typescript-npm', 'configured']),
    source: z.enum(['package.json', REVIEW_CONFIG_FILENAME]),
    commands: z.array(
      z.object({
        kind: checkKindSchema,
        argv: argvSchema,
        timeoutMs: z.number().int().positive(),
      }),
    ),
  }),
  z.object({ ecosystem: z.literal('unsupported'), reason: z.string() }),
])

const decisionSchema = z.union([
  z.object({ execute: z.literal(true), reason: z.string() }),
  z.object({ execute: z.literal(false), reason: z.string() }),
])

export const stage0ReportSchema = z.object({
  version: z.literal(STAGE0_REPORT_VERSION),
  repositoryRoot: z.string(),
  baseRef: z.string(),
  mergeBase: z.string().nullable(),
  headCommit: z.string().nullable(),
  dirtyWorkingTree: z.boolean(),
  execution: z.object({
    backend: z.string(),
    strength: z.enum(['none', 'os-sandbox', 'container']),
    decision: decisionSchema,
  }),
  project: z.object({ head: projectSchema.nullable(), base: projectSchema.nullable() }),
  preparation: z.object({ head: checkRunSchema.nullable(), base: checkRunSchema.nullable() }),
  checks: z.array(checkOutcomeSchema),
  findings: z.array(findingSchema),
  coverage: z.object({
    checked: z.array(checkKindSchema),
    notChecked: z.array(
      z.object({ kind: z.union([checkKindSchema, z.literal('all')]), reason: z.string() }),
    ),
  }),
  durationMs: z.number(),
})

const decodeShape = decodeWithSchema(stage0ReportSchema)

/** Older jobs promoted checker crashes to confirmed findings. Do not import that verdict. */
function normalizeIncompleteChecks(report: Stage0Report): Stage0Report {
  const incomplete = new Map(
    report.checks.flatMap((check) => {
      if (check.verdict !== 'regressed' && check.verdict !== 'failing-on-base') return []
      const reason =
        (check.head === null ? null : inconclusiveCheckReason(check.head)) ??
        (check.base === null ? null : inconclusiveCheckReason(check.base))
      return reason === null ? [] : [[check.kind, reason] as const]
    }),
  )
  if (incomplete.size === 0) return report
  return {
    ...report,
    checks: report.checks.map((check) => {
      const reason = incomplete.get(check.kind)
      return reason === undefined ? check : { ...check, verdict: 'undetermined', reason }
    }),
    findings: report.findings.filter((finding) => {
      if (!finding.provenance.raisedBy.some((source) => source.kind === 'stage0')) return true
      return !(
        (finding.class === 'type' && incomplete.has('typecheck')) ||
        (finding.class === 'build' && incomplete.has('build')) ||
        (finding.class === 'test' && incomplete.has('test'))
      )
    }),
    coverage: {
      checked: report.coverage.checked.filter((kind) => !incomplete.has(kind)),
      notChecked: [
        ...report.coverage.notChecked.filter(
          (note) => note.kind === 'all' || !incomplete.has(note.kind),
        ),
        ...[...incomplete].map(([kind, reason]) => ({ kind, reason })),
      ],
    },
  }
}

function normalizeLegacyFailures(report: Stage0Report): Stage0Report {
  const reason =
    'legacy double-failure result has no complete individual failure inventories; new regressions remain unverified'
  const unknown = report.checks.filter(
    (check) =>
      check.verdict === 'failing-on-base' &&
      (check.kind !== 'test' || !check.head?.testFailures || !check.base?.testFailures),
  )
  if (unknown.length === 0) return report
  return {
    ...report,
    checks: report.checks.map((check) =>
      unknown.includes(check) ? { ...check, verdict: 'undetermined', reason } : check,
    ),
    coverage: {
      ...report.coverage,
      notChecked: [
        ...report.coverage.notChecked,
        ...unknown.map((check) => ({ kind: check.kind, reason })),
      ],
    },
  }
}

/**
 * A Stage 0 report from untrusted JSON, or `null`. Accepts the bare report and
 * the full review report that carries one under `stage0` (what `--json`
 * writes), so a CI job hands over the file it already has.
 */
export function decodeStage0Report(value: unknown): Stage0Report | null {
  const bare = decodeShape(value)
  if (bare !== null) return normalizeLegacyFailures(normalizeIncompleteChecks(bare))
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'stage0')) {
    const wrapped = decodeShape(Reflect.get(value, 'stage0'))
    return wrapped === null ? null : normalizeLegacyFailures(normalizeIncompleteChecks(wrapped))
  }
  return null
}
