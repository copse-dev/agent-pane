import { readFileSync } from 'node:fs'
import type { Options } from '@wdio/types'
import { exclusionRegistrySchema } from './scripts/lib/e2e-exclusions.mts'
import { quarantinedSpecs } from './scripts/lib/e2e-quarantine.mts'
import { decodeWithSchema, safeJsonParse } from './scripts/lib/safe-json.mts'
import { config as ciConfig } from './wdio.ci.conf.ts'
import { config as baseConfig } from './wdio.conf.ts'

/**
 * Nightly quarantine run (.github/workflows/e2e-quarantine.yml): the CI gate's
 * settings, applied to exactly the specs tests/e2e/exclusions.json records as
 * `quarantine` with a `wdio.ci.conf.ts: exclude` marker. The list is read from
 * the registry at load time, so adding or restoring a quarantine needs no edit
 * here. Results are advisory and never gate a merge.
 */
const registry = safeJsonParse(
  readFileSync(new URL('./tests/e2e/exclusions.json', import.meta.url), 'utf8'),
  decodeWithSchema(exclusionRegistrySchema),
)
if (!registry) throw new Error('Invalid tests/e2e/exclusions.json')
const quarantined = quarantinedSpecs(registry)
if (quarantined.length === 0)
  throw new Error('No quarantined specs; run `node scripts/e2e-quarantine.mts specs` first')

export const config: Options.Testrunner = {
  ...ciConfig,
  specs: quarantined.map((spec) => `./${spec}`),
  // The CI exclusions are what put these specs here; keep only the base ones.
  exclude: baseConfig.exclude ?? [],
  // No in-process retry either: a streak should count first-attempt passes.
  specFileRetries: 0,
}
