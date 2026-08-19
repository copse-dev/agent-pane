#!/usr/bin/env node
// Nightly watch: has the ACP TypeScript SDK published a protocol-v2 API yet?
//
// Copse's whole ACP integration is protocol v1 by design. The published
// `@agentclientprotocol/sdk` line ships `PROTOCOL_VERSION === 1` and no v2
// types, so there is nothing to negotiate, adapt, or probe today — the reasons
// are laid out in docs/acp-v2-readiness.md. Upstream, though, v2 is real and
// moving (stable v2 baseline schema, migration guide, active RFD stream), so
// the open question is not *whether* the SDK gains v2 but *when* — and until
// now the only answer came from someone re-checking npm by hand.
//
// This script is that re-check, automated. It reads the registry's abbreviated
// packument and fails the run when the published line grows anything that could
// carry v2: a major >= 2 release, or a dist-tag beyond the v1 line's `latest`
// (`next` / `v2` / `beta` is how a v2 SDK would surface first). Failing IS the
// notification; the migration checklist lives in docs/acp-v2-readiness.md
// ("When v2 stabilizes — the plan").
//
// Two deliberate properties:
//   - Dependency-free (node builtins + repo-local modules only), so the nightly
//     workflow runs it straight after `actions/setup-node` and skips the
//     multi-minute dependency restore `./.github/actions/setup` pays for.
//   - Acknowledgeable. A candidate that has been triaged but not yet migrated
//     goes in REVIEWED_RELEASES, so the watch reports it without going red
//     every night for the length of the migration.
//
// The offline half of the same question — that the SDK we actually build
// against still reports protocol v1 — is pinned in acp-v2-watch.test.ts and
// runs in the normal unit gate, with no network.
//
// Run locally:  npm run watch:acp-v2            (human-readable report)
//               npm run watch:acp-v2 -- --json  (machine-readable verdict)

import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isRecord, stringRecordOrEmpty } from '../src/shared/unknown-value.mts'

export const SDK_PACKAGE = '@agentclientprotocol/sdk'

/** Scoped names are percent-encoded in a registry path (`@scope%2Fname`). */
const REGISTRY_URL = `https://registry.npmjs.org/${SDK_PACKAGE.replace('/', '%2F')}`

/**
 * The abbreviated packument: dist-tags plus a trimmed entry per version, a few
 * KB instead of the full document's megabytes. Everything this watch reads
 * (tag targets, the version list) is in it.
 */
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

/**
 * Dist-tags the v1 line publishes. Anything else is a channel that did not
 * exist while the SDK was v1-only, which is exactly how a v2 (or unstable-v2)
 * build would first appear — see docs/acp-v2-readiness.md.
 */
const V1_DIST_TAGS: readonly string[] = ['latest']

/**
 * The SDK's 0.29 -> 1.0 jump was v1 going *stable*, not v2 arriving, so the
 * whole 1.x line is protocol v1. A major bump is therefore the version-shaped
 * signal worth waking someone for.
 */
const FIRST_CANDIDATE_MAJOR = 2

/**
 * Candidates a human has already looked at. Add a version or dist-tag here
 * (with the date and what was decided) once it has been triaged but the
 * migration has not landed yet — the watch keeps reporting it and stops going
 * red for it. Empty today: nothing beyond the v1 line has ever been published.
 */
const REVIEWED_RELEASES: readonly string[] = []

const READINESS_DOC = 'docs/acp-v2-readiness.md'

export interface Packument {
  distTags: Record<string, string>
  versions: string[]
  /** Registry's last-publish timestamp for the package; '' when absent. */
  modified: string
}

export interface WatchSignal {
  /** `version`/`dist-tag` come from the registry; `pin` from our package.json. */
  kind: 'version' | 'dist-tag' | 'pin'
  /** Version string, dist-tag name, or dependency range, depending on kind. */
  name: string
  /** The version the signal points at. */
  target: string
  why: string
  /** True once the target appears in REVIEWED_RELEASES. */
  reviewed: boolean
}

export interface WatchVerdict {
  package: string
  /**
   * `v1-only` — nothing but the v1 line exists (today's expected answer).
   * `v2-candidate` — an untriaged signal; the run goes red.
   * `reviewed` — every signal is acknowledged in REVIEWED_RELEASES.
   */
  status: 'v1-only' | 'v2-candidate' | 'reviewed'
  latest: string
  pinnedRange: string
  modified: string
  signals: WatchSignal[]
}

export interface SemverParts {
  major: number
  minor: number
  patch: number
  /** '' for a release, e.g. 'alpha.1' for 2.0.0-alpha.1. */
  prerelease: string
}

export function parseSemver(version: string): SemverParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return null
  const [, major = '0', minor = '0', patch = '0', prerelease = ''] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease }
}

/** Lowest major a range can install, so `^1.3.0` reads as the v1 line. */
export function rangeMajor(range: string): number | null {
  const match = /(\d+)\.(?:\d+|x|\*)/.exec(range)
  const [, major] = match ?? []
  return major === undefined ? null : Number(major)
}

/**
 * `JSON.parse` that yields `null` rather than throwing, so every field below is
 * narrowed from `unknown` at the boundary instead of being asserted.
 *
 * Local rather than `src/shared/safe-json.ts`: that file is a `.ts` under the
 * root CommonJS manifest, so an ESM `.mts` script cannot import it — only the
 * `.mts` modules under `src/` (hence `unknown-value.mts` above) resolve here.
 */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return null
  }
}

export function decodePackument(text: string): Packument {
  const value: unknown = parseJson(text)
  if (!isRecord(value)) throw new Error(`${SDK_PACKAGE}: registry response was not a JSON object`)
  const versionsRecord = value['versions']
  if (!isRecord(versionsRecord)) throw new Error(`${SDK_PACKAGE}: packument has no versions map`)
  const distTags = stringRecordOrEmpty(value['dist-tags'])
  if (Object.keys(distTags).length === 0) {
    throw new Error(`${SDK_PACKAGE}: packument has no dist-tags`)
  }
  const modified = value['modified']
  return {
    distTags,
    versions: Object.keys(versionsRecord),
    modified: typeof modified === 'string' ? modified : '',
  }
}

export async function fetchPackument(fetchImpl: typeof fetch = fetch): Promise<Packument> {
  const res = await fetchImpl(REGISTRY_URL, { headers: { accept: ABBREVIATED_PACKUMENT } })
  if (!res.ok) {
    throw new Error(`npm registry -> ${String(res.status)} ${res.statusText} for ${SDK_PACKAGE}`)
  }
  return decodePackument(await res.text())
}

/** The range this repo builds against, read from the root manifest. */
export function readPinnedRange(manifestPath = resolve('package.json')): string {
  const manifest: unknown = parseJson(readFileSync(manifestPath, 'utf8'))
  const dependencies = isRecord(manifest) ? stringRecordOrEmpty(manifest['dependencies']) : {}
  const range = dependencies[SDK_PACKAGE]
  if (range === undefined) throw new Error(`${SDK_PACKAGE} is not a dependency of ${manifestPath}`)
  return range
}

export function evaluateWatch(
  packument: Packument,
  pinnedRange: string,
  reviewedReleases: readonly string[] = REVIEWED_RELEASES,
): WatchVerdict {
  const signals: WatchSignal[] = []
  const reviewed = (target: string): boolean => reviewedReleases.includes(target)

  for (const version of packument.versions) {
    const parts = parseSemver(version)
    if (parts === null || parts.major < FIRST_CANDIDATE_MAJOR) continue
    signals.push({
      kind: 'version',
      name: version,
      target: version,
      why:
        `major ${String(parts.major)} release` +
        (parts.prerelease === '' ? '' : ` (prerelease ${parts.prerelease})`) +
        ' — the protocol-v1 line is 1.x, so this can carry v2 types',
      reviewed: reviewed(version),
    })
  }

  for (const [tag, target] of Object.entries(packument.distTags)) {
    if (V1_DIST_TAGS.includes(tag)) continue
    signals.push({
      kind: 'dist-tag',
      name: tag,
      target,
      why: `dist-tag beyond \`latest\` — a v2 or unstable-v2 build would ship on a channel like this first`,
      reviewed: reviewed(tag) || reviewed(target),
    })
  }

  const pinned = rangeMajor(pinnedRange)
  if (pinned !== null && pinned >= FIRST_CANDIDATE_MAJOR) {
    signals.push({
      kind: 'pin',
      name: pinnedRange,
      target: pinnedRange,
      why: `package.json already depends on a major >= ${String(FIRST_CANDIDATE_MAJOR)} range — the v1 adapters in src/main/services/acp must have moved with it`,
      reviewed: reviewed(pinnedRange),
    })
  }

  const status =
    signals.length === 0
      ? 'v1-only'
      : signals.some((s) => !s.reviewed)
        ? 'v2-candidate'
        : 'reviewed'

  return {
    package: SDK_PACKAGE,
    status,
    latest: packument.distTags['latest'] ?? '',
    pinnedRange,
    modified: packument.modified,
    signals,
  }
}

export function formatReport(verdict: WatchVerdict): string {
  const lines = [
    '### ACP v2 SDK watch',
    '',
    `- package: \`${verdict.package}\``,
    `- \`latest\`: \`${verdict.latest}\``,
    `- pinned in package.json: \`${verdict.pinnedRange}\``,
  ]
  if (verdict.modified !== '') lines.push(`- registry last modified: ${verdict.modified}`)
  lines.push('')

  if (verdict.status === 'v1-only') {
    lines.push(
      `No protocol-v2 signal: the published SDK line is still v1-only, so Copse's v1 ACP`,
      `integration remains correct. See \`${READINESS_DOC}\` for what changes when that ends.`,
    )
    return lines.join('\n')
  }

  lines.push(
    verdict.status === 'reviewed'
      ? '**Known candidate release(s), already triaged** — no action beyond the migration already tracked.'
      : `**Candidate v2 SDK release(s) found.** Work the plan in \`${READINESS_DOC}\` ("When v2 stabilizes").`,
    '',
    '| signal | name | target | reviewed | why |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const signal of verdict.signals) {
    lines.push(
      `| ${signal.kind} | \`${signal.name}\` | \`${signal.target}\` | ${signal.reviewed ? 'yes' : 'no'} | ${signal.why} |`,
    )
  }
  if (verdict.status === 'v2-candidate') {
    lines.push(
      '',
      'First step is triage, not a bump: confirm the release actually exports v2 types',
      '(`PROTOCOL_VERSION`, the v2 schema) before touching the adapters. If it does not — or',
      'if it does and the migration will take more than a night — record it in',
      '`REVIEWED_RELEASES` in `scripts/acp-v2-watch.mts` so this watch stops going red for it.',
    )
  }
  return lines.join('\n')
}

function usage(): string {
  return `Usage:
  npm run watch:acp-v2 [-- --json]

Checks the npm registry for a protocol-v2 release of ${SDK_PACKAGE}
(major >= ${String(FIRST_CANDIDATE_MAJOR)}, or a dist-tag beyond \`latest\`) and exits non-zero when it
finds an untriaged one. See ${READINESS_DOC}.`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(usage())
    return
  }
  const verdict = evaluateWatch(await fetchPackument(), readPinnedRange())
  const report = formatReport(verdict)
  console.log(args.includes('--json') ? JSON.stringify(verdict, null, 2) : report)

  // Surface the same report on the GitHub Actions run summary when available.
  const stepSummary = process.env['GITHUB_STEP_SUMMARY']
  if (stepSummary !== undefined && stepSummary !== '') {
    await writeFile(stepSummary, `${report}\n`, { flag: 'a' })
  }

  if (verdict.status === 'v2-candidate') process.exitCode = 1
}

if (process.argv[1]?.endsWith('acp-v2-watch.mts')) {
  main().catch((error: unknown) => {
    console.error(`acp v2 watch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
