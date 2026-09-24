// Node test reporter selected by run-tests --review-report. Repository code still
// runs only inside the review execution cell; the host consumes this as data.
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { TEST_FAILURE_REPORT_PREFIX, testFailureReportSchema } from '@copse/review/test-failures.ts'

const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    name: z.string().optional(),
    file: z.string().optional(),
    testId: z.number().optional(),
    parentId: z.number().optional(),
    skip: z.union([z.boolean(), z.string()]).optional(),
    todo: z.union([z.boolean(), z.string()]).optional(),
    details: z
      .object({
        type: z.string().optional(),
        error: z.object({ failureType: z.string().optional() }).optional(),
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
