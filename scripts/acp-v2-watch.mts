#!/usr/bin/env node
// Nightly watch: how much of ACP protocol v2 does the published TypeScript SDK
// expose, and has that surface changed since we last looked?
//
// Copse's ACP integration is protocol v1: the SDK's MAIN entry point ships
// `PROTOCOL_VERSION === 1`, the session-update adapter parses a v1-only union,
// and the capability probe requests v1 (docs/acp-v2-readiness.md). What that
// doc used to say — that the published SDK carries no v2 types at all — stopped
// being true at 1.3.0, the version this repo pins: `@agentclientprotocol/sdk`
// now also publishes `./experimental/v2`, whose `PROTOCOL_VERSION` is 2.
//
// That is exactly the shape a watch is easy to get wrong on. v2 did NOT arrive
// as a major bump or a `next` dist-tag; it arrived as a new subpath export in a
// minor release. So this script's primary signal is the package's own EXPORT
// MAP, read from the registry, compared against the surface we have already
// triaged (ACKNOWLEDGED below). It goes red when that surface moves — most
// importantly when a v2 entry point appears OUTSIDE `./experimental/`, which is
// the real migration trigger — and stays quiet while the surface is the one we
// have already reasoned about.
//
// Two deliberate properties:
//   - Dependency-free (node builtins + repo-local modules only), so the nightly
//     workflow runs it straight after `actions/setup-node` and skips the
//     multi-minute dependency restore `./.github/actions/setup` pays for.
//   - Acknowledgeable. Everything already triaged is listed in ACKNOWLEDGED with
//     the reasoning, so a months-long migration does not leave a nightly that is
//     red every morning and therefore ignored.
//
// What it does NOT do: it reads the npm registry, not the upstream git repo
// (agentclientprotocol/typescript-sdk), and it does not exercise any ACP code.
// Copse's own ACP unit tests run in the normal gate on every PR; the agent
// probes (`npm run probe:acp*`) need real installed agents and stay manual.
//
// Run locally:  npm run watch:acp-v2            (human-readable report)
//               npm run watch:acp-v2 -- --json  (machine-readable verdict)

import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isRecord, stringRecordOrEmpty } from '../src/shared/unknown-value.mts'

export const SDK_PACKAGE = '@agentclientprotocol/sdk'

/** Scoped names are percent-encoded in a registry path (`@scope%2Fname`). */
const REGISTRY_BASE = `https://registry.npmjs.org/${SDK_PACKAGE.replace('/', '%2F')}`

/**
 * The abbreviated packument: dist-tags plus a trimmed entry per version, a few
 * KB instead of the full document's megabytes. It carries tag targets and the
 * version list — but NOT the export map, which is why the manifest below is a
 * second request.
 */
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

/**
 * Dist-tags the v1 line publishes. Anything else is a channel that did not exist
 * while the SDK was v1-only — a plausible home for a v2 or unstable-v2 build.
 */
const V1_DIST_TAGS: readonly string[] = ['latest']

/**
 * The SDK's 0.29 -> 1.0 jump was v1 going *stable*, not v2 arriving, so the whole
 * 1.x line negotiates v1 from its main entry. A major bump is still worth waking
 * someone for — it is just no longer the only way v2 can reach us.
 */
const FIRST_CANDIDATE_MAJOR = 2

/**
 * Signals already triaged, as `kind:name`. Anything here is reported but does not
 * fail the run; anything NOT here does. Add an entry (with what was decided and
 * when) rather than widening the detectors — the point is that a NEW shape is
 * always loud.
 *
 * Today's entries: v2 shipped in 1.3.0 as an experimental subpath. Copse stays on
 * the v1 main entry deliberately — `experimental/` is upstream's own "not stable
 * yet" marker, and the v2 migration is a rewrite of the session-update adapter,
 * permission bridge, and write path, not a dependency bump. See
 * docs/acp-v2-readiness.md.
 */
const ACKNOWLEDGED: readonly string[] = [
  'export:./experimental/v2', // v2 API, experimental subpath, since 1.3.0 (2026-07)
  'export:./schema/v2/schema.unstable.json', // the unstable v2 schema it is generated from
]

const READINESS_DOC = 'docs/acp-v2-readiness.md'

/** Matches an export subpath that carries v2, e.g. `./experimental/v2`, `./v2/foo`. */
const V2_SUBPATH = /(?:^|\/)v2(?:$|\/|\.)/

export interface Packument {
  distTags: Record<string, string>
  versions: string[]
  /** Registry's last-publish timestamp for the package; '' when absent. */
  modified: string
}

/** The `latest` version's own manifest — the only place the export map lives. */
export interface Manifest {
  version: string
  exportPaths: string[]
}

export interface WatchSignal {
  /**
   * `export` — a v2 subpath in the published package's export map (how v2
   * actually arrived). `version`/`dist-tag` — registry-shaped arrivals.
   * `pin` — our own package.json moved.
   */
  kind: 'export' | 'version' | 'dist-tag' | 'pin'
  /** Export subpath, version string, dist-tag name, or dependency range. */
  name: string
  why: string
  /** True once `kind:name` appears in ACKNOWLEDGED. */
  acknowledged: boolean
}

export interface WatchVerdict {
  package: string
  /**
   * `as-expected` — the published surface is the one we have already triaged.
   * `changed` — something new; the run goes red.
   */
  status: 'as-expected' | 'changed'
  latest: string
  pinnedRange: string
  modified: string
  /** Every v2 export subpath the published `latest` carries, acknowledged or not. */
  v2Exports: string[]
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

export function decodeManifest(text: string): Manifest {
  const value: unknown = parseJson(text)
  if (!isRecord(value)) throw new Error(`${SDK_PACKAGE}: manifest response was not a JSON object`)
  const version = value['version']
  if (typeof version !== 'string') throw new Error(`${SDK_PACKAGE}: manifest has no version`)
  const exportsField = value['exports']
  // A package with a single string `exports` (or none) has no subpaths at all,
  // which is a real answer — no v2 entry point — not a decode failure.
  const exportPaths = isRecord(exportsField) ? Object.keys(exportsField) : []
  return { version, exportPaths }
}

async function fetchJson(url: string, accept: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: { accept } })
  if (!res.ok) {
    throw new Error(`npm registry -> ${String(res.status)} ${res.statusText} for ${url}`)
  }
  return await res.text()
}

export async function fetchPackument(fetchImpl: typeof fetch = fetch): Promise<Packument> {
  return decodePackument(await fetchJson(REGISTRY_BASE, ABBREVIATED_PACKUMENT, fetchImpl))
}

/**
 * The `latest` manifest, i.e. that version's package.json. Requested separately
 * because neither packument form carries `exports`, and the export map is the
 * signal that would otherwise be missed: v2 reached npm as `./experimental/v2`
 * in the minor release 1.3.0.
 */
export async function fetchLatestManifest(fetchImpl: typeof fetch = fetch): Promise<Manifest> {
  return decodeManifest(await fetchJson(`${REGISTRY_BASE}/latest`, 'application/json', fetchImpl))
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
  manifest: Manifest,
  pinnedRange: string,
  acknowledged: readonly string[] = ACKNOWLEDGED,
): WatchVerdict {
  const signals: WatchSignal[] = []
  const add = (kind: WatchSignal['kind'], name: string, why: string): void => {
    signals.push({ kind, name, why, acknowledged: acknowledged.includes(`${kind}:${name}`) })
  }

  const v2Exports = manifest.exportPaths.filter((path) => V2_SUBPATH.test(path))
  for (const path of v2Exports) {
    // `./experimental/...` is upstream's own "not stable yet" marker. A v2 entry
    // point outside it means v2 has graduated, which is the migration trigger.
    const stable = !path.startsWith('./experimental/')
    add(
      'export',
      path,
      stable
        ? 'v2 entry point OUTSIDE `./experimental/` — v2 has graduated on the published package'
        : 'v2 entry point published behind the experimental marker',
    )
  }

  for (const version of packument.versions) {
    const parts = parseSemver(version)
    if (parts === null || parts.major < FIRST_CANDIDATE_MAJOR) continue
    add(
      'version',
      version,
      `major ${String(parts.major)} release` +
        (parts.prerelease === '' ? '' : ` (prerelease ${parts.prerelease})`) +
        " — the main entry's v1 line is 1.x, so this can negotiate v2 by default",
    )
  }

  for (const [tag, target] of Object.entries(packument.distTags)) {
    if (V1_DIST_TAGS.includes(tag)) continue
    add(
      'dist-tag',
      tag,
      `dist-tag beyond \`latest\` (-> ${target}) — a v2 or unstable-v2 build could ship on a channel like this`,
    )
  }

  const pinned = rangeMajor(pinnedRange)
  if (pinned !== null && pinned >= FIRST_CANDIDATE_MAJOR) {
    add(
      'pin',
      pinnedRange,
      `package.json depends on a major >= ${String(FIRST_CANDIDATE_MAJOR)} range — the v1 adapters in src/main/services/acp must have moved with it`,
    )
  }

  return {
    package: SDK_PACKAGE,
    status: signals.some((signal) => !signal.acknowledged) ? 'changed' : 'as-expected',
    latest: packument.distTags['latest'] ?? '',
    pinnedRange,
    modified: packument.modified,
    v2Exports,
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
    `- v2 entry points published: ${
      verdict.v2Exports.length === 0
        ? 'none'
        : verdict.v2Exports.map((path) => `\`${path}\``).join(', ')
    }`,
  ]
  if (verdict.modified !== '') lines.push(`- registry last modified: ${verdict.modified}`)
  lines.push('')

  if (verdict.status === 'as-expected') {
    lines.push(
      "The published v2 surface is the one already triaged in `ACKNOWLEDGED`: Copse's",
      `integration stays on the v1 main entry. See \`${READINESS_DOC}\`.`,
    )
    return lines.join('\n')
  }

  lines.push(
    `**The published SDK surface moved.** Work the plan in \`${READINESS_DOC}\` ("When v2 stabilizes").`,
    '',
    '| signal | name | known | why |',
    '| --- | --- | --- | --- |',
  )
  for (const signal of verdict.signals) {
    lines.push(
      `| ${signal.kind} | \`${signal.name}\` | ${signal.acknowledged ? 'yes' : '**new**'} | ${signal.why} |`,
    )
  }
  lines.push(
    '',
    'Triage before bumping: confirm what the new surface actually negotiates. If the',
    'migration will take longer than a night, add the new `kind:name` to `ACKNOWLEDGED`',
    'in `scripts/acp-v2-watch.mts` with the reasoning, so this watch stops going red',
    'for a decision that has already been made.',
  )
  return lines.join('\n')
}

function usage(): string {
  return `Usage:
  npm run watch:acp-v2 [-- --json]

Reports the protocol-v2 surface ${SDK_PACKAGE} publishes (v2 export
subpaths, major >= ${String(FIRST_CANDIDATE_MAJOR)} releases, dist-tags beyond \`latest\`) and exits non-zero
when it differs from the surface already triaged. See ${READINESS_DOC}.`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(usage())
    return
  }
  const [packument, manifest] = await Promise.all([fetchPackument(), fetchLatestManifest()])
  const verdict = evaluateWatch(packument, manifest, readPinnedRange())
  const report = formatReport(verdict)
  console.log(args.includes('--json') ? JSON.stringify(verdict, null, 2) : report)

  // Surface the same report on the GitHub Actions run summary when available.
  const stepSummary = process.env['GITHUB_STEP_SUMMARY']
  if (stepSummary !== undefined && stepSummary !== '') {
    await writeFile(stepSummary, `${report}\n`, { flag: 'a' })
  }

  if (verdict.status === 'changed') process.exitCode = 1
}

if (process.argv[1]?.endsWith('acp-v2-watch.mts')) {
  main().catch((error: unknown) => {
    console.error(`acp v2 watch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
