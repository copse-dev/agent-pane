// A compact complete failure inventory, emitted after Node's final test summary.
// It survives noisy/truncated console output without equating two red exit codes.
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

export const TEST_FAILURE_REPORT_PREFIX = 'COPSE_TEST_FAILURES_V1 '
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

export function newTestFailures(
  base: TestFailureReport,
  head: TestFailureReport,
): TestFailureReport['failures'] {
  const known = new Set(base.failures.map((failure) => JSON.stringify(failure)))
  return head.failures.filter((failure) => !known.has(JSON.stringify(failure)))
}
