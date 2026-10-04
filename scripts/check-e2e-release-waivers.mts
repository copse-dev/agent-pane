import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  decodeOwnerReviewEvidence,
  decodeReleaseExclusions,
  ownerReviewApiPath,
  ownerReviewErrors,
  quarantineReleaseErrors,
  quarantineScopeDigest,
} from './lib/e2e-release-policy.mts'
import { safeJsonParse } from './lib/safe-json.mts'

import { pathToFileURL } from 'node:url'

function main(): void {
  const entries = safeJsonParse(
    readFileSync('tests/e2e/exclusions.json', 'utf8'),
    decodeReleaseExclusions,
  )
  if (!entries)
    throw new Error(
      'Invalid exclusion release policy; run pnpm run check:e2e-exclusions for full registry diagnostics.',
    )
  const errors = quarantineReleaseErrors(entries, new Date().toISOString().slice(0, 10))
  if (errors.length === 0) {
    for (const entry of entries) {
      const waiver = entry.accountability?.waiver
      if (!waiver) continue
      const path = ownerReviewApiPath(waiver.decisionUrl)
      if (!path) throw new Error(`Unsupported waiver review URL: ${entry.spec}`)
      const result = spawnSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000 })
      const evidence =
        result.status === 0 ? safeJsonParse(result.stdout, decodeOwnerReviewEvidence) : null
      if (!evidence) errors.push(`Cannot verify the live owner review: ${entry.spec}`)
      else errors.push(...ownerReviewErrors(entry, evidence))
    }
  }
  for (const entry of entries.filter((entry) => entry.category === 'quarantine')) {
    console.log(
      `quarantine: ${entry.spec}; owner ${entry.accountability?.owner ?? 'unassigned'}; ${entry.accountability?.disposition ?? 'unreviewed'}; scope ${quarantineScopeDigest(entry)}`,
    )
  }
  for (const error of errors) console.error(`check-e2e-release-waivers: ${error}`)
  if (errors.length > 0) process.exitCode = 1
  else
    console.log(
      'check-e2e-release-waivers: every quarantine has a current owner-reviewed waiver; platform and deliberate service tiers retain their own evidence requirements.',
    )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
