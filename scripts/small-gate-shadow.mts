import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  changedFiles,
  computeSelection,
  listCiSpecs,
  read,
  readShardWeights,
  assignShards,
} from './test-oracle.mts'
import { computeSmallGate, parseSmokeInventory } from './lib/small-gate.mts'

const base = process.env['BASE_SHA'] ?? process.argv[2] ?? 'origin/main'
const env = process.env
const suite = listCiSpecs()
const directory = 'e2e-evidence'
mkdirSync(directory, { recursive: true })
function optionalSha(value: string | undefined): string | null {
  if (!value) return null
  return value
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const selectedMode = env['ACTUAL_MODE'] ?? 'full'
const selectedSpecs =
  selectedMode === 'full' ? suite : (env['ACTUAL_SPECS'] ?? '').split(/\s+/).filter(Boolean)
writeFileSync(
  join(directory, 'selected-plan.json'),
  JSON.stringify({
    version: 1,
    runId: env['GITHUB_RUN_ID'] ?? 'local',
    runAttempt: env['GITHUB_RUN_ATTEMPT'] ?? '1',
    commit,
    head: optionalSha(env['HEAD_SHA']),
    shadowAvailable: false,
    actual: {
      mode: selectedMode,
      specs: selectedSpecs,
      shards:
        selectedMode === 'skip'
          ? 0
          : selectedMode === 'full'
            ? 8
            : Math.min(8, Math.ceil(selectedSpecs.length / 4)),
      unitMode: env['UNIT_MODE'] ?? 'full',
      unitSpecs: env['UNIT_SPECS'] ?? '',
    },
    proposed: { mode: 'full', specs: suite, count: suite.length, shards: 8 },
    estimate: {
      savedSpecMinutes: 0,
      caveat: 'Shadow unavailable; no savings or miss-rate estimate.',
    },
    rawOutputs: {
      mode: env['ACTUAL_MODE'],
      specs: env['ACTUAL_SPECS'],
      unitMode: env['UNIT_MODE'],
      unitSpecs: env['UNIT_SPECS'],
    },
  }) + '\n',
)
const inventory = parseSmokeInventory(read('tests/e2e/smoke-inventory.json'))
const selection = computeSelection(changedFiles(base))
const forced =
  env['STACK_TIP'] === 'true' ||
  env['CI_FULL_LABEL'] === 'true' ||
  env['UPDATE_SCREENSHOTS_LABEL'] === 'true' ||
  env['EVENT'] === 'schedule' ||
  (env['EVENT'] === 'push' &&
    (env['GITHUB_REF'] === 'refs/heads/release' ||
      (env['GITHUB_REF'] ?? '').startsWith('refs/tags/v'))) ||
  (env['BASE_REF'] ?? '').replace('refs/heads/', '') === 'release'
const proposed = computeSmallGate(selection, suite, inventory, forced)
const actualMode = env['ACTUAL_MODE'] ?? 'full'
const actualSpecs =
  actualMode === 'full' ? suite : (env['ACTUAL_SPECS'] ?? '').split(/\s+/).filter(Boolean)
const shards = (mode: string, count: number): number =>
  mode === 'skip' ? 0 : mode === 'full' ? 8 : Math.min(8, Math.ceil(count / 4))
const seconds = readShardWeights()
const median = [...seconds.values()].sort((a, b) => a - b)[Math.floor(seconds.size / 2)] ?? 0
function estimate(
  specs: string[],
  count: number,
): { specMinutes: number; wallSpecMinutes: number; shards: number } {
  const costs = assignShards(specs, count || 1, seconds).map(
    (group) => group.reduce((sum, spec) => sum + (seconds.get(spec) ?? median) + 1.3, 0) / 60,
  )
  return {
    specMinutes: costs.reduce((sum, cost) => sum + cost, 0),
    wallSpecMinutes: Math.max(0, ...costs),
    shards: count,
  }
}
const actual = {
  mode: actualMode,
  specs: actualSpecs,
  shards: shards(actualMode, actualSpecs.length),
  unitMode: env['UNIT_MODE'] ?? 'full',
  unitSpecs: (env['UNIT_SPECS'] ?? '').split(/\s+/).filter(Boolean),
}
const proposedShards = shards(proposed.mode, proposed.count)
const actualEstimate = estimate(actual.specs, actual.shards)
const proposedEstimate = estimate(proposed.specs, proposedShards)
const report = {
  version: 1,
  runId: env['GITHUB_RUN_ID'] ?? 'local',
  runAttempt: env['GITHUB_RUN_ATTEMPT'] ?? '1',
  commit,
  shadowAvailable: true,
  head: optionalSha(env['HEAD_SHA']),
  base,
  event: env['EVENT'] ?? 'local',
  baseRef: (env['BASE_REF'] ?? '').replace('refs/heads/', ''),
  ref: env['GITHUB_REF'] ?? '',
  draft: env['PR_DRAFT'] === 'true',
  labels: {
    ciFull: env['CI_FULL_LABEL'] === 'true',
    updateScreenshots: env['UPDATE_SCREENSHOTS_LABEL'] === 'true',
  },
  stackTip: env['STACK_TIP'] === 'true',
  changed: selection.changed,
  baseUnknown: selection.baseUnknown,
  confidence: selection.confidence,
  unmapped: selection.unmapped,
  broadHits: selection.broadHits,
  selectedOutputs: read('e2e-evidence/selected-plan.json'),
  actual,
  proposed: { ...proposed, shards: proposedShards },
  inventory,
  estimate: {
    actual: actualEstimate,
    proposed: proposedEstimate,
    savedSpecMinutes: actualEstimate.specMinutes - proposedEstimate.specMinutes,
    caveat:
      'Committed medians + 1.3s/spec; excludes provisioning, downloads, retries and queue time. Drafts dispatch no e2e unless labelled. Not measured job or CI wall minutes.',
  },
}
writeFileSync(join(directory, 'plan.json'), JSON.stringify(report, null, 2) + '\n')
const summary = `### Small gate (shadow)\n\nWould select ${String(proposed.count)} specs on ${String(proposedShards)} shards; actual plan ${actualMode} (${String(actual.specs.length)} specs). ${proposed.reason}.\n\nEstimated spec minutes saved: ${report.estimate.savedSpecMinutes.toFixed(1)}. ${report.estimate.caveat}\n\n<details><summary>Selected specs</summary>\n\n${proposed.specs.map((spec) => '- ' + spec).join('\n')}\n\n</details>\n`
console.log(summary)
if (env['GITHUB_STEP_SUMMARY']) appendFileSync(env['GITHUB_STEP_SUMMARY'], summary)
if (env['GITHUB_OUTPUT'])
  appendFileSync(
    env['GITHUB_OUTPUT'],
    `shadow_mode=${proposed.mode}\nshadow_count=${String(proposed.count)}\nshadow_shards=${String(proposedShards)}\n`,
  )
