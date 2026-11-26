// A compact complete failure inventory, emitted after Node's final test summary.
// It survives noisy/truncated console output without equating two red exit codes.
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

export const TEST_FAILURE_REPORT_PREFIX = 'COPSE_TEST_FAILURES_V1 '
/**
 * How the reporter begins the line it prints instead of an inventory when the
 * results were incomplete (a cancelled test, a file that failed to load). The
 * text has not changed since the inventory existed, so older revisions match.
 */
export const TEST_FAILURE_REPORT_UNAVAILABLE = 'Copse test failure inventory unavailable: '
export const testFailureReportSchema = z
  .object({
    tier: z.literal('unit-component'),
    complete: z.literal(true),
    failed: z.number().int().nonnegative(),
    failures: z.array(
      z.object({
        path: z
          .string()
          .min(1)
          .refine(
            (path) =>
              !path.startsWith('/') &&
              !path.includes('\\') &&
              !path.split('/').includes('..') &&
              !/^[a-z]:/i.test(path),
          ),
        name: z.string().min(1),
      }),
    ),
    /**
     * Tests that never ran because a suite above them failed (its own entry
     * is in `failures`). They are accounted for, but were not compared.
     */
    notRun: z.number().int().nonnegative().optional(),
  })
  .refine(
    (report) =>
      report.failed === report.failures.length &&
      new Set(report.failures.map((failure) => JSON.stringify(failure))).size ===
        report.failures.length,
  )
export type TestFailureReport = z.infer<typeof testFailureReportSchema>
const decodeReport = decodeWithSchema(testFailureReportSchema)

export function parseTestFailureReport(output: string): TestFailureReport | null {
  const reports = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(TEST_FAILURE_REPORT_PREFIX))
  if (reports.length !== 1) return null
  return safeJsonParse(reports[0]?.slice(TEST_FAILURE_REPORT_PREFIX.length) ?? '', decodeReport)
}

/**
 * Whether a test run's own reporter finished and said its failure list was
 * incomplete. The runner did run: this is a failed check without a list to
 * compare, not a checker that could not start.
 */
export function reportedIncompleteTestInventory(run: {
  readonly kind: string
  readonly testFailures?: TestFailureReport | undefined
  readonly output: string
}): boolean {
  return (
    run.kind === 'test' &&
    run.testFailures === undefined &&
    run.output.split(/\r?\n/).some((line) => line.startsWith(TEST_FAILURE_REPORT_UNAVAILABLE))
  )
}

/**
 * Whether a failure sits inside a unit that failed in `base`: a suite whose
 * `before` hook failed, or a whole file (named by its path), which cancels
 * every test below it. Those tests never ran there, so `base` says nothing
 * about them.
 */
export function underFailedBaseUnit(
  base: TestFailureReport,
  failure: TestFailureReport['failures'][number],
): boolean {
  return base.failures.some(
    (unit) =>
      unit.path === failure.path &&
      (unit.name === unit.path || failure.name.startsWith(`${unit.name} > `)),
  )
}

export function newTestFailures(
  base: TestFailureReport,
  head: TestFailureReport,
): TestFailureReport['failures'] {
  const known = new Set(base.failures.map((failure) => JSON.stringify(failure)))
  return head.failures.filter((failure) => !known.has(JSON.stringify(failure)))
}
