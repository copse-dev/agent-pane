import { globSync, readFileSync } from 'node:fs'
import {
  collectE2eExclusions,
  exclusionRegistrySchema,
  validateExclusionRegistry,
} from './lib/e2e-exclusions.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

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
for (const spec of result.due)
  console.warn(`check-e2e-exclusions: review due (not a release waiver): ${spec}`)
for (const entry of registry.entries)
  console.log(
    `${entry.category}: ${entry.spec} — ${entry.ownerRole}; review by ${entry.reviewBy}; ${entry.tracker}`,
  )
console.log(
  `check-e2e-exclusions: ${String(registry.entries.length)} specs, ${String(actual.length)} exclusion markers, ${String(result.due.length)} reviews due. Inventory is not acceptance of missing coverage.`,
)
if (result.errors.length > 0) process.exitCode = 1
