// A failed review may still have rendered a valid summary. Retain its identity
// without changing the review's exit status or publishing from the model job.
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeActionRequest } from './action-policy.mts'
import { summaryFileIdentity } from './summary-artifact.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const runnerTemp = process.env['RUNNER_TEMP']
const output = process.env['GITHUB_OUTPUT']
if (!runnerTemp || !output) throw new Error('Summary identity requires runner-owned scratch/output')
const digest = await summaryFileIdentity(
  join(runnerTemp, 'copse-review-summary', 'summary.json'),
  request,
)
await appendFile(output, digest === null ? 'ready=false\n' : `ready=true\nsha256=${digest}\n`)
