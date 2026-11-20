// Trusted, model-free publication entry point. No contributor code is loaded.
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeActionRequest } from './action-policy.mts'
import {
  publishSummaryArtifact,
  verifySummaryArtifactMetadata,
  verifySummaryPayload,
} from './summary-artifact.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const token = process.env['SUMMARY_PUBLISH_TOKEN'] ?? ''
const artifactId = process.env['SUMMARY_ARTIFACT_ID'] ?? ''
const runId = process.env['GITHUB_RUN_ID'] ?? ''
const digest = process.env['SUMMARY_ARTIFACT_DIGEST'] ?? ''
if (!token.trim()) throw new Error('Summary publication requires its workflow token')
if (process.env['GITHUB_REPOSITORY'] !== request.repository) {
  throw new Error('Summary request is not for this workflow repository')
}
if (!/^[1-9][0-9]*$/.test(artifactId) || !/^[1-9][0-9]*$/.test(runId)) {
  throw new Error('Summary publication requires immutable artifact and workflow run IDs')
}
const response = await fetch(
  `https://api.github.com/repos/${request.repository}/actions/artifacts/${artifactId}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
)
if (!response.ok) throw new Error('GitHub could not attest the summary artifact')
verifySummaryArtifactMetadata(await response.text(), { artifactId, runId, digest })
if (!process.argv.includes('--verify-artifact')) {
  const runnerTemp = process.env['RUNNER_TEMP']
  if (!runnerTemp) throw new Error('Summary publisher requires runner-owned scratch')
  const path = join(runnerTemp, 'copse-review-summary', 'summary.json')
  const info = await lstat(path)
  if (!info.isFile() || info.size > 65536) throw new Error('Invalid summary payload file')
  const bytes = await readFile(path)
  verifySummaryPayload(bytes, process.env['SUMMARY_SHA256'] ?? '')
  const result = await publishSummaryArtifact(bytes.toString('utf8'), request, token)
  console.log(result.updated ? 'Published review summary' : `Summary unchanged: ${result.reason}`)
}
