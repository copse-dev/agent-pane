import { main } from '../src/cli.ts'
import { writeFile } from 'node:fs/promises'
import { encodeSummaryArtifact } from './summary-artifact.mts'
import { actionPublishingFetch, decodeActionRequest } from './action-policy.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const summaryOutput = process.env['COPSE_REVIEW_SUMMARY_OUTPUT']
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    controller.abort()
  })
}
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  signal: controller.signal,
  fetch: actionPublishingFetch(request, process.env['COPSE_REVIEW_READ_TOKEN'] ?? ''),
  ...(summaryOutput
    ? {
        deferSummary: async (block: string, head: string | null): Promise<void> => {
          if (head !== request.head)
            throw new Error('Summary does not describe the authorized head')
          await writeFile(summaryOutput, encodeSummaryArtifact(request, block), { flag: 'wx' })
        },
      }
    : {}),
})
