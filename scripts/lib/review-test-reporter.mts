// Live CI diagnostics and an EOF-only complete inventory for review consumers.
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { TEST_FAILURE_REPORT_PREFIX, testFailureReportSchema } from '@copse/review/test-failures.ts'

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

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function bounded(value: string | undefined, limit = 1024): string | undefined {
  return value && value.length > limit ? `${value.slice(0, limit)} [truncated]` : value
}

export default async function* reviewTestReporter(
  source: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  const names = new Map<string, string>()
  const failures: { path: string; name: string }[] = []
  let valid = true
  let failed: number | undefined
  const outputDir = process.env['COPSE_TEST_OUTPUT_DIR']
  const root = canonicalPath(outputDir ?? process.cwd())
  for await (const event of source) {
    const parsed = eventSchema.safeParse(event)
    if (!parsed.success) {
      valid = false
      continue
    }
    const { type, data } = parsed.data
    if (type === 'test:start' && data.file && data.name && data.testId !== undefined) {
      const stableName =
        data.name === data.file
          ? relative(root, canonicalPath(data.file))
              .replaceAll('\\', '/')
              .replace(/\.mjs$/, '.ts')
          : data.name
      const parent = names.get(`${data.file}:${String(data.parentId)}`)
      names.set(
        `${data.file}:${String(data.testId)}`,
        parent ? `${parent} > ${stableName}` : stableName,
      )
    }
    if (type === 'test:fail') {
      const error = data.details?.error
      const cause = errorTextSchema.safeParse(error?.cause)
      // A diagnostic describes this event, including parent/expected/cancelled
      // failures. It is not a unique assertion count or a complete inventory.
      // Only entryPath is normalized; the other locations name the raw bundle.
      yield `\nCopse test failure event: ${JSON.stringify({
        entryPath: bounded(
          data.file
            ? relative(root, canonicalPath(data.file))
                .replaceAll('\\', '/')
                .replace(/\.mjs$/, '.ts')
            : undefined,
        ),
        file: bounded(data.file),
        bundleLine: data.line,
        bundleColumn: data.column,
        name: bounded(
          names.get(`${data.file ?? ''}:${String(data.testId)}`) ?? data.name ?? '(unnamed)',
        ),
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
      const name = names.get(`${data.file ?? ''}:${String(data.testId)}`)
      if (!data.file || !name || data.details?.error?.failureType === 'cancelledByParent') {
        valid = false
        continue
      }
      // The bundled entries mirror source paths under a per-run scratch dir.
      const path = relative(root, canonicalPath(data.file))
        .replaceAll('\\', '/')
        .replace(/\.mjs$/, '.ts')
      if (path.startsWith('../') || path.length === 0) {
        valid = false
        continue
      }
      failures.push({ path, name })
    }
    if (type === 'test:summary' && data.file === undefined) {
      if (data.counts === undefined || data.counts.cancelled !== 0 || failed !== undefined)
        valid = false
      failed = data.counts?.failed
    }
  }
  const report = testFailureReportSchema.safeParse({
    tier: 'unit-component',
    complete: true,
    failed,
    failures,
  })
  if (valid && report.success)
    yield `\n${TEST_FAILURE_REPORT_PREFIX}${JSON.stringify(report.data)}\n`
  else
    yield 'Copse test failure inventory unavailable: incomplete, cancelled, or ambiguous test results.\n'
}
