/** Read-only GitHub collection. Run where gh can access api.github.com. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { gateManifestSchema, gateEvidenceLinks } from './lib/gate-report.mts'
const directory = process.argv[2]
const limit = Number(process.argv[3] ?? '300')
if (!directory || !Number.isInteger(limit) || limit < 1 || limit > 1000)
  throw new Error('Usage: node scripts/collect-gate-evidence.mts <directory> [1..1000 runs]')
const repository = 'copse-dev/agent-pane'
const origin = 'https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev'
const runSchema = z.object({
  id: z.number().int(),
  run_attempt: z.number().int(),
  head_sha: z.string(),
  created_at: z.iso.datetime(),
})
const runsSchema = z.object({ workflow_runs: z.array(runSchema) })
const checksSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      details_url: z.string().nullable(),
      output: z.object({ summary: z.string().nullable() }).optional(),
    }),
  ),
})
const api = (path: string): string =>
  execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 20_000_000, timeout: 60_000 })
if (existsSync(join(directory, 'manifest.json')))
  throw new Error('Choose a fresh directory to preserve existing classifications and evidence')
mkdirSync(directory, { recursive: true })
const manifest: z.infer<typeof gateManifestSchema> = []
writeFileSync(join(directory, 'manifest.json'), '[]\n')
const checks = new Map<string, string[]>()
for (let page = 1; manifest.length < limit; page++) {
  const response = safeJsonParse(
    api(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&per_page=100&page=${String(page)}`,
    ),
    decodeWithSchema(runsSchema),
  )
  if (!response) throw new Error('Invalid workflow runs')
  if (!response.workflow_runs.length) break
  for (const run of response.workflow_runs) {
    if (manifest.length >= limit) break
    const entry: z.infer<typeof gateManifestSchema>[number] = {
      runId: String(run.id),
      attempt: String(run.run_attempt),
      head: run.head_sha,
      createdAt: run.created_at,
    }
    try {
      let urls = checks.get(run.head_sha)
      if (!urls) {
        urls = []
        for (let checkPage = 1; ; checkPage++) {
          const result = safeJsonParse(
            api(
              `repos/${repository}/commits/${run.head_sha}/check-runs?per_page=100&page=${String(checkPage)}&filter=all`,
            ),
            decodeWithSchema(checksSchema),
          )
          if (!result) throw new Error('Invalid check runs')
          for (const check of result.check_runs)
            if (check.name === 'Small gate (shadow)')
              urls.push(...gateEvidenceLinks(check.details_url, check.output?.summary ?? null))
          if (result.check_runs.length < 100) break
        }
        checks.set(run.head_sha, urls)
      }
      const matches = [...new Set(urls)].filter((value) => {
        const url = new URL(value)
        return (
          url.origin === origin &&
          new RegExp(
            `^/ci-evidence/v1/${String(run.id)}/${String(run.run_attempt)}/[a-f0-9]{64}\\.json$`,
          ).test(url.pathname) &&
          !url.search &&
          !url.hash
        )
      })
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? 'Ambiguous durable records'
            : 'No durable shadow record for this run attempt',
        )
      const url = matches[0]
      if (!url) throw new Error('Missing URL')
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !response.body)
        throw new Error(`Evidence download HTTP ${String(response.status)}`)
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 20_000_000) throw new Error('Evidence exceeds 20 MB')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (!url.endsWith(`/${digest}.json`)) throw new Error('Evidence digest mismatch')
      entry.record = `${String(run.id)}-${String(run.run_attempt)}.json`
      entry.sha256 = digest
      writeFileSync(join(directory, entry.record), bytes)
    } catch (error) {
      entry.missingReason = error instanceof Error ? error.message : String(error)
    }
    manifest.push(entry)
    // Checkpoint every run so an interrupted collection retains its evidence gaps.
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
}
console.log(
  `Collected ${String(manifest.length)} candidate runs; ${String(manifest.filter((row) => row.record).length)} durable records. Manifest: ${join(directory, 'manifest.json')}`,
)
