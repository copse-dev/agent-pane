// Trusted default-branch code only. This job never installs or executes PR code.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { GROUND_POLICY_PATHS, reusableGroundReport, reusableGroundRun } from './reusable-ground.mts'

function command(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
}
function api(path: string): unknown {
  const value: unknown = JSON.parse(command('gh', ['api', path]))
  return value
}
function findReusable(): number | null {
  const pr = z.coerce.number().int().positive().parse(process.env['PR_NUMBER'])
  const head = z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(process.env['HEAD_SHA'])
  const base = z.literal('main').parse(process.env['BASE_REF'])
  const repo = z.literal('copse-dev/agent-pane').parse(process.env['GITHUB_REPOSITORY'])
  command('git', [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/pull/${String(pr)}/head:refs/remotes/pr/${String(pr)}`,
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ])
  if (command('git', ['rev-parse', `refs/remotes/pr/${String(pr)}`]).trim() !== head) return null
  const mergeBase = command('git', ['merge-base', head, `origin/${base}`]).trim()
  const request = { pr, head, mergeBase, now: Date.now() }
  const runs = z
    .object({ workflow_runs: z.array(z.unknown()) })
    .parse(
      api(
        `repos/${repo}/actions/workflows/review-ground.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=30`,
      ),
    )
  for (const candidate of runs.workflow_runs) {
    const id = reusableGroundRun(candidate, request)
    if (id === null) continue
    const run = z.object({ head_sha: z.string() }).parse(candidate)
    try {
      // A main-branch run must also be an ancestor of this trusted checkout.
      command('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD'])
      command('git', ['diff', '--quiet', run.head_sha, 'HEAD', '--', ...GROUND_POLICY_PATHS])
      const artifacts = z
        .object({
          artifacts: z.array(
            z.object({
              id: z.number().int().positive(),
              name: z.string(),
              expired: z.boolean(),
              size_in_bytes: z.number(),
            }),
          ),
        })
        .parse(api(`repos/${repo}/actions/runs/${String(id)}/artifacts`)).artifacts
      const matches = artifacts.filter((artifact) => artifact.name === 'copse-review-ground')
      const artifact = matches[0]
      if (
        matches.length !== 1 ||
        !artifact ||
        artifact.expired ||
        artifact.size_in_bytes > 8 * 1024 * 1024
      )
        continue
      const dir = mkdtempSync(join(tmpdir(), 'copse-ground-reuse-'))
      try {
        const archive = join(dir, 'ground.zip')
        writeFileSync(
          archive,
          execFileSync(
            'gh',
            ['api', `repos/${repo}/actions/artifacts/${String(artifact.id)}/zip`],
            { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          ),
        )
        // Read just this member, with a decompressed output limit. Never extract
        // archive paths or trust an artifact-supplied executable/helper.
        const json = execFileSync('unzip', ['-p', archive, 'report.json'], {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
        })
        const value: unknown = JSON.parse(json)
        if (reusableGroundReport(value, request)) return id
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // Expired artifacts, unavailable history and malformed reports are misses.
    }
  }
  return null
}

let source: number | null = null
try {
  source = findReusable()
} catch {
  console.log('No verified reusable grounding available; running fresh checks.')
}
const output = process.env['GITHUB_OUTPUT']
if (!output) throw new Error('GITHUB_OUTPUT is required')
appendFileSync(output, `run_id=${source === null ? '' : String(source)}\n`)
if (source !== null) {
  const url = `https://github.com/copse-dev/agent-pane/actions/runs/${String(source)}`
  console.log(`Reusing clean grounding for the same head and merge-base: ${url}`)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary)
    appendFileSync(
      summary,
      `Reused [successful grounding](${url}) for the identical head and merge-base.\n`,
    )
}
