import { globSync, readFileSync } from 'node:fs'
import {
  collectE2eExclusions,
  exclusionCheckFails,
  exclusionRegistrySchema,
  validateExclusionRegistry,
  type ExclusionCheckMode,
} from './lib/e2e-exclusions.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

// `--enforce` is for the nightly schedule and release gating: an expired or
// unowned quarantine fails there, but only warns in PR prechecks and check:local
// so it cannot block unrelated work.
// pnpm forwards its own `--` separator.
const args = process.argv.slice(2).filter((arg) => arg !== '--')
for (const arg of args) if (arg !== '--enforce') throw new Error(`Unknown argument: ${arg}`)
const mode: ExclusionCheckMode = args.includes('--enforce') ? 'enforce' : 'warn'

const sources = new Map(
  globSync(['wdio*.conf.ts', 'tests/e2e/**/*.e2e.ts']).map((path) => [
    path.replaceAll('\\', '/'),
    readFileSync(path, 'utf8'),
  ]),
)
const registry = safeJsonParse(
  readFileSync('tests/e2e/exclusions.json', 'utf8'),
  decodeWithSchema(exclusionRegistrySchema),
)
if (!registry)
  throw new Error('Invalid tests/e2e/exclusions.json; every exclusion needs review metadata.')
const actual = collectE2eExclusions(sources)
const result = validateExclusionRegistry(
  registry,
  actual,
  new Set(sources.keys()),
  new Date().toISOString().slice(0, 10),
)
for (const error of result.errors) console.error(`check-e2e-exclusions: ${error}`)
for (const problem of result.quarantine) {
  if (mode === 'enforce') console.error(`check-e2e-exclusions: ${problem}`)
  else console.warn(`check-e2e-exclusions: warning (fails with --enforce): ${problem}`)
}
for (const problem of result.stale) console.warn(`check-e2e-exclusions: warning: ${problem}`)
for (const entry of registry.entries)
  console.log(
    entry.category === 'quarantine'
      ? `quarantine: ${entry.spec} — owner ${entry.owner ?? 'unassigned'}; review by ${entry.renewal?.reviewBy ?? entry.reviewBy}${entry.renewal ? ' (renewed)' : ''}; ${entry.tracker}`
      : `${entry.category}: ${entry.spec} — ${entry.ownerRole}; last verified ${entry.lastVerified ? `${entry.lastVerified.on} ${entry.lastVerified.evidence}` : 'missing'}; ${entry.tracker}`,
  )
console.log(
  `check-e2e-exclusions (${mode}): ${String(registry.entries.length)} specs, ${String(actual.length)} exclusion markers, ${String(result.quarantine.length)} quarantine problems, ${String(result.stale.length)} stale verifications. Inventory is not acceptance of missing coverage.`,
)
if (exclusionCheckFails(result, mode)) process.exitCode = 1
