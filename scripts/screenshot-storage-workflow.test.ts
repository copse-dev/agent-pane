import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
})
const workflow = z
  .object({
    on: z
      .object({
        workflow_dispatch: z.unknown(),
        push: z.object({ branches: z.array(z.string()), paths: z.array(z.string()) }),
      })
      .strict(),
    permissions: z.object({ contents: z.literal('read') }).strict(),
    jobs: z.object({
      storage: z.object({
        env: z.record(z.string(), z.string()),
        steps: z.array(stepSchema),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/screenshot-storage.yml', 'utf8')))

describe('screenshot storage workflow', () => {
  it('automatically publishes only accepted main screenshots, without PR triggers', () => {
    assert.deepEqual(workflow.on.push.branches, ['main'])
    assert.ok(workflow.on.push.paths.includes('tests/e2e/screenshots/**'))
    assert.ok(workflow.on.push.paths.includes('.github/workflows/screenshot-storage.yml'))
    assert.ok(!Object.hasOwn(workflow.on, 'pull_request'))
    assert.ok(!Object.hasOwn(workflow.on, 'pull_request_target'))
    const generation = workflow.jobs.storage.steps.find(
      (step) => step.run === 'pnpm screenshots:manifest',
    )
    assert.ok(generation)
    assert.equal(generation.if, undefined)
    const check = workflow.jobs.storage.steps.findIndex(
      (step) => step.run === 'pnpm screenshots:check',
    )
    const generate = workflow.jobs.storage.steps.findIndex(
      (step) => step.run === 'pnpm screenshots:manifest',
    )
    assert.ok(generate >= 0 && generate < check)
  })

  it('keeps R2 credentials out of checkout, dependency installation, and public verification', () => {
    const { env, steps } = workflow.jobs.storage
    assert.ok(!Object.hasOwn(env, 'SCREENSHOT_R2_ACCESS_KEY_ID'))
    assert.ok(!Object.hasOwn(env, 'SCREENSHOT_R2_SECRET_ACCESS_KEY'))
    const credentialSteps = steps.filter((step) =>
      Object.hasOwn(step.env ?? {}, 'SCREENSHOT_R2_SECRET_ACCESS_KEY'),
    )
    assert.deepEqual(
      credentialSteps.map((step) => step.name),
      ['Check upload configuration', 'Upload immutable objects and verify their contents'],
    )
    for (const step of credentialSteps) {
      assert.ok(step.env)
      assert.equal(step.if, "github.event_name == 'push' || inputs.operation == 'upload'")
      assert.equal(
        step.env['SCREENSHOT_R2_ACCESS_KEY_ID'],
        '${{ secrets.SCREENSHOT_R2_ACCESS_KEY_ID }}',
      )
      assert.equal(
        step.env['SCREENSHOT_R2_SECRET_ACCESS_KEY'],
        '${{ secrets.SCREENSHOT_R2_SECRET_ACCESS_KEY }}',
      )
    }
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout?.with?.['persist-credentials'], false)
    const verify = steps.find((step) => step.run === 'pnpm screenshots:verify')
    assert.ok(verify)
    assert.equal(verify.if, "inputs.operation == 'verify'")
    assert.equal(verify.env, undefined)
  })

  it('checks local integrity before upload and saves evidence only after remote verification', () => {
    const { steps } = workflow.jobs.storage
    const check = steps.findIndex((step) => step.run === 'pnpm screenshots:check')
    const upload = steps.findIndex((step) => step.run === 'pnpm screenshots:upload')
    const verify = steps.findIndex((step) => step.run === 'pnpm screenshots:verify')
    const artifact = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'))
    assert.ok(check >= 0 && upload > check && verify > check)
    assert.ok(artifact > upload && artifact > verify)
    assert.equal(steps[artifact]?.with?.['path'], 'tests/e2e/screenshots/manifest.json')
    assert.ok(steps.every((step) => !step.run?.includes('${{')))
    assert.match(
      workflow.jobs.storage.env['SCREENSHOT_R2_PUBLIC_URL'] ?? '',
      /pub-7ec931b58a7b480ba1cd3e535dc12f3c\.r2\.dev/,
    )
  })
})
