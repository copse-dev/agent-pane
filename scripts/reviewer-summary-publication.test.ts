import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'

const stepSchema = z.object({
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})
const jobSchema = z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  permissions: z.record(z.string(), z.string()),
  outputs: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
})
const workflow = z
  .object({ jobs: z.record(z.string(), jobSchema) })
  .parse(load(readFileSync('.github/workflows/reviewer.yml', 'utf8')))

describe('full review summary publication boundary', () => {
  it('keeps model context read-only and gives only the model-free publisher artifact/PR access', () => {
    const model = workflow.jobs['copse-findings']
    const publisher = workflow.jobs['publish-summary']
    assert.ok(model && publisher)
    assert.deepEqual(model.permissions, { contents: 'read', 'pull-requests': 'read' })
    assert.deepEqual(publisher.permissions, {
      contents: 'read',
      actions: 'read',
      'pull-requests': 'write',
    })
    assert.deepEqual(publisher.needs, ['authorize', 'findings', 'copse-findings'])
    const serialized = JSON.stringify(publisher)
    assert.doesNotMatch(
      serialized,
      /secrets\.|model-api-key|app-private-key|COPSE_REVIEW_TARGET|copse-review-models/,
    )
    const checkout = publisher.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout?.with?.['ref'], '${{ inputs.reviewer-ref }}')
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(publisher.env?.['COPSE_REVIEW_REQUEST'], '${{ needs.authorize.outputs.request }}')
    const verify = publisher.steps.findIndex((step) => step.run?.includes('--verify-artifact'))
    const download = publisher.steps.findIndex((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    )
    const publish = publisher.steps.findIndex(
      (step) => step.run === 'node packages/review/ci/publish-summary.mts',
    )
    assert.ok(verify >= 0 && verify < download && download < publish)
    assert.equal(
      publisher.steps[download]?.with?.['artifact-ids'],
      '${{ env.SUMMARY_ARTIFACT_ID }}',
    )
    for (const field of ['summary-artifact-id', 'summary-artifact-digest', 'summary-sha256']) {
      for (const job of ['findings', 'copse-findings']) {
        assert.equal(
          workflow.jobs[job]?.outputs?.[field],
          `\${{ steps.findings.outputs.${field} }}`,
        )
      }
    }
  })

  it('documents the reusable caller permission ceiling for immutable artifact attestation', () => {
    const guide = readFileSync('packages/review/ACTIONS.md', 'utf8')
    assert.match(guide, /contents: read\n {6}actions: read\n {6}pull-requests: write/)
    const caller = readFileSync('.github/workflows/review-trigger.yml', 'utf8')
    assert.match(caller, /^ {6}actions: read$/m)
  })

  it('uploads only the rendered summary and retains the App token for findings', () => {
    const action = z
      .object({ runs: z.object({ steps: z.array(stepSchema) }) })
      .parse(load(readFileSync('.github/actions/review-findings/action.yml', 'utf8')))
    const model = action.runs.steps.find((step) => step.run?.includes('ci/run-action.mts'))
    assert.equal(model?.env?.['COPSE_REVIEW_READ_TOKEN'], '${{ inputs.github-token }}')
    assert.equal(
      model.env['COPSE_REVIEW_FORGE_TOKEN'],
      '${{ steps.app-token.outputs.token || inputs.github-token }}',
    )
    assert.match(model.run ?? '', /export COPSE_REVIEW_SUMMARY_OUTPUT=/)
    const upload = action.runs.steps.find((step) => step.id === 'summary-upload')
    assert.equal(upload?.with?.['path'], '${{ runner.temp }}/copse-review-summary/summary.json')
    assert.equal(upload.with['if-no-files-found'], 'error')
  })
})
