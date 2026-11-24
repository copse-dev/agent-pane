// Live CI diagnostics and an EOF-only complete inventory for review consumers.
//
// The inventory names every failure once, so Copse Reviewer can compare a base
// and a head run test by test. A suite that fails on its own (a `before` hook
// that throws because a tool is missing, a `describe` body that throws) is one
// entry, and the tests it cancelled are accounted for by it: they never ran, on
// either side, until the suite itself is fixed. A cancellation with no failed
// suite or test above it, a test without a name, or a count that does not
// reconcile with Node's own summary still leaves the inventory unavailable.
import { z } from 'zod'
import {
  TEST_FAILURE_REPORT_PREFIX,
  TEST_FAILURE_REPORT_UNAVAILABLE,
  testFailureReportSchema,
} from '@copse/review/test-failures.ts'
import { TestNames, testEntryPath } from './test-event-names.mts'

const errorTextSchema = z.object({
  message: z.string().optional().catch(undefined),
  stack: z.string().optional().catch(undefined),
})

const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    name: z.string().optional(),
    file: z.string().optional(),
    testId: z.number().optional(),
    parentId: z.number().optional(),
    line: z.number().optional().catch(undefined),
    column: z.number().optional().catch(undefined),
    skip: z.union([z.boolean(), z.string()]).optional(),
    todo: z.union([z.boolean(), z.string()]).optional(),
    details: z
      .object({
        type: z.string().optional(),
        error: errorTextSchema
          .extend({
            failureType: z.string().optional(),
            cause: z.unknown().optional(),
          })
          .optional(),
      })
      .optional(),
    counts: z.object({ failed: z.number(), cancelled: z.number() }).optional(),
  }),
})

function bounded(value: string | undefined, limit = 1024): string | undefined {
  return value && value.length > limit ? `${value.slice(0, limit)} [truncated]` : value
}

export default async function* reviewTestReporter(
  source: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  const failures: { path: string; name: string }[] = []
  let valid = true
  let failed: number | undefined
  let cancelledInSummary: number | undefined
  const root = process.env['COPSE_TEST_OUTPUT_DIR'] ?? process.cwd()
  const names = new TestNames(root)
  const key = (file: string, testId: number | undefined): string => `${file}:${String(testId)}`
  const parents = new Map<string, string>()
  // Recorded failures, by event key, and how many of them are suites: Node
  // counts neither failed nor cancelled suites in its summary.
  const recorded = new Set<string>()
  let suiteFailures = 0
  // Tests that outran their timeout. Each ran and failed, so it is recorded,
  // but Node cancels it and counts it as cancelled, not failed, in its summary.
  let timedOut = 0
  // Children cancelled by a parent arrive before that parent's own failure.
  const cancelled: { key: string; suite: boolean }[] = []
  for await (const event of source) {
    const parsed = eventSchema.safeParse(event)
    if (!parsed.success) {
      valid = false
      continue
    }
    const { type, data } = parsed.data
    if (type === 'test:start' && data.file && data.name && data.testId !== undefined) {
      names.start(data.file, data.testId, data.parentId, data.name)
      if (data.parentId !== undefined)
        parents.set(key(data.file, data.testId), key(data.file, data.parentId))
    }
    if (type === 'test:fail') {
      const error = data.details?.error
      const cause = errorTextSchema.safeParse(error?.cause)
      // A diagnostic describes this event, including parent/expected/cancelled
      // failures. It is not a unique assertion count or a complete inventory.
      // Only entryPath is normalized; the other locations name the raw bundle.
      yield `\nCopse test failure event: ${JSON.stringify({
        entryPath: bounded(data.file ? testEntryPath(root, data.file) : undefined),
        file: bounded(data.file),
        bundleLine: data.line,
        bundleColumn: data.column,
        name: bounded(names.get(data.file ?? '', data.testId) ?? data.name ?? '(unnamed)'),
        failureType: bounded(error?.failureType ?? 'unknown'),
        skip: typeof data.skip === 'string' ? bounded(data.skip) : (data.skip ?? false),
        todo: typeof data.todo === 'string' ? bounded(data.todo) : (data.todo ?? false),
        message: bounded(error?.message),
        stack: bounded(error?.stack, 4096),
        causeMessage: bounded(
          cause.success
            ? cause.data.message
            : typeof error?.cause === 'string'
              ? error.cause
              : undefined,
        ),
        causeStack: bounded(cause.success ? cause.data.stack : undefined, 4096),
      })}\n`
    }
    if (type === 'test:fail' && !data.skip && !data.todo) {
      if (data.details?.error?.failureType === 'subtestsFailed') continue
      const name = names.get(data.file ?? '', data.testId)
      if (!data.file || !name) {
        valid = false
        continue
      }
      const suite = data.details?.type === 'suite'
      if (data.details?.error?.failureType === 'cancelledByParent') {
        cancelled.push({ key: key(data.file, data.testId), suite })
        continue
      }
      const path = testEntryPath(root, data.file)
      if (path.startsWith('../') || path.length === 0) {
        valid = false
        continue
      }
      failures.push({ path, name })
      recorded.add(key(data.file, data.testId))
      if (suite) suiteFailures += 1
      else if (data.details?.error?.failureType === 'testTimeoutFailure') timedOut += 1
    }
    if (type === 'test:summary' && data.file === undefined) {
      if (data.counts === undefined || failed !== undefined) valid = false
      failed = data.counts?.failed
      cancelledInSummary = data.counts?.cancelled
    }
  }
  const failedAbove = (start: string): boolean => {
    for (let at = parents.get(start); at !== undefined; at = parents.get(at)) {
      if (recorded.has(at)) return true
    }
    return false
  }
  if (!cancelled.every((entry) => failedAbove(entry.key))) valid = false
  if (cancelledInSummary !== cancelled.filter((entry) => !entry.suite).length + timedOut)
    valid = false
  const report = testFailureReportSchema.safeParse({
    tier: 'unit-component',
    complete: true,
    failed: failed === undefined ? undefined : failed + suiteFailures + timedOut,
    failures,
    // Only when a failed suite cancelled something, so an ordinary run's
    // inventory keeps its shape.
    ...(cancelled.some((entry) => !entry.suite)
      ? { notRun: cancelled.filter((entry) => !entry.suite).length }
      : {}),
  })
  if (valid && report.success)
    yield `\n${TEST_FAILURE_REPORT_PREFIX}${JSON.stringify(report.data)}\n`
  else yield `${TEST_FAILURE_REPORT_UNAVAILABLE}incomplete, cancelled, or ambiguous test results.\n`
}
