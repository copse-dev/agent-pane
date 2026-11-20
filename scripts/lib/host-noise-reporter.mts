// Local `pnpm test` reporter: after the run, lists failed tests and marks the
// ones that match a known host difference (scripts/lib/host-differences.mts).
// It only adds a summary; the stock reporter still prints every failure in
// full, and the run's exit status is Node's.
import { z } from 'zod'
import { formatHostNoiseSummary, type FailedTest } from './host-differences.mts'
import { TestNames, testEntryPath } from './test-event-names.mts'

const messageSchema = z.object({ message: z.string() })

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
        error: z
          .object({
            failureType: z.string().optional(),
            message: z.string().optional(),
            cause: z.unknown().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
})

export default async function* hostNoiseReporter(
  source: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  const root = process.env['COPSE_TEST_OUTPUT_DIR'] ?? process.cwd()
  const names = new TestNames(root)
  const failures: FailedTest[] = []
  for await (const event of source) {
    const parsed = eventSchema.safeParse(event)
    if (!parsed.success) continue
    const { type, data } = parsed.data
    if (type === 'test:start' && data.file && data.name && data.testId !== undefined)
      names.start(data.file, data.testId, data.parentId, data.name)
    if (type !== 'test:fail' || data.skip || data.todo) continue
    const error = data.details?.error
    // A failed suite repeats its children; a cancelled child repeats its parent.
    if (error?.failureType === 'subtestsFailed' || error?.failureType === 'cancelledByParent')
      continue
    const cause = messageSchema.safeParse(error?.cause)
    failures.push({
      path: data.file ? testEntryPath(root, data.file) : '(unknown file)',
      name: (data.file ? names.get(data.file, data.testId) : undefined) ?? data.name ?? '(unnamed)',
      messages: [
        error?.message ?? '',
        cause.success ? cause.data.message : typeof error?.cause === 'string' ? error.cause : '',
      ].filter((message) => message.length > 0),
    })
  }
  const summary = formatHostNoiseSummary(failures, process.platform)
  if (summary) yield summary
}
