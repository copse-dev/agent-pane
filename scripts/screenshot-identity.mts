/**
 * Shadow-mode rendering-input identity for reference screenshots.
 *
 *   screenshot-identity.mts prepare
 *     Hydrate the R2 baselines (the e2e launcher would do the same) and stamp a
 *     marker. A PNG written after the marker was rendered by this shard's specs.
 *
 *   screenshot-identity.mts record --shard <i>/<n> --out <file> [--specs <a b …>]
 *                                   [--pr-head <sha>] [--base <sha>]
 *     Resolve the shard's specs exactly as the e2e step does, hash every
 *     rendering input the oracle maps to them, and write one record per
 *     reference screenshot: identity, inputs with their hashes, PNG sha256 and
 *     whether this run rendered it. The output is validated by the same decoder
 *     a reader uses before it is written.
 *
 * Observe-only. No gate, status, label or acceptance path reads the output; it
 * is uploaded as a CI artifact so docs/plans/screenshot-evidence-reuse.md can be
 * measured before any reuse is proposed. See that plan before extending this.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { isRecord } from '../src/shared/unknown-value.mts'
import { resolveElectronBrowserVersion } from '../tests/e2e/helpers/electron-browser-version.ts'
import { isDirectExecution } from './lib/direct-execution.mts'
import { safeJsonParse } from './lib/safe-json.mts'
import { hydrateScreenshots } from './lib/screenshot-hydration.mts'
import {
  buildIdentityRecords,
  environmentFromRunner,
  parseShard,
  provenanceFromRunner,
  serializeIdentityRecords,
  type IdentityTree,
  type ScreenshotFile,
} from './lib/screenshot-identity.mts'
import {
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
} from './lib/screenshot-manifest.mts'
import { assignShards, listCiSpecs, readShardWeights } from './test-oracle.mts'

const ROOT = process.cwd()
/** Beside the verified R2 objects, so the Actions cache never carries it. */
export const RENDER_MARKER = '.cache/screenshots/render-marker'

function workingTree(): IdentityTree {
  const walk = (dir: string, out: string[] = []): string[] => {
    const abs = join(ROOT, dir)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return out
    for (const name of readdirSync(abs).sort()) {
      const rel = `${dir}/${name}`
      const st = lstatSync(join(ROOT, rel))
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(rel, out)
      else if (st.isFile()) out.push(rel)
    }
    return out
  }
  return {
    paths: (dir) => walk(dir),
    read: (rel): string => {
      try {
        return readFileSync(join(ROOT, rel), 'utf8')
      } catch {
        return ''
      }
    },
    exists: (rel) => existsSync(join(ROOT, rel)),
    isFile: (rel): boolean => {
      try {
        return lstatSync(join(ROOT, rel)).isFile()
      } catch {
        return false
      }
    },
  }
}

function hashFile(rel: string): string {
  return createHash('sha256')
    .update(readFileSync(join(ROOT, rel)))
    .digest('hex')
}

function screenshot(name: string): ScreenshotFile | null {
  const path = join(ROOT, SCREENSHOT_DIRECTORY, name)
  if (relative(join(ROOT, SCREENSHOT_DIRECTORY), path).includes('..')) return null
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return null
    return { bytes: readFileSync(path), mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function electronVersions(): { electron: string; chromium: string } {
  const requireFromProject = createRequire(join(ROOT, 'package.json'))
  const electronPackage = requireFromProject.resolve('electron/package.json')
  const electron = safeJsonParse(readFileSync(electronPackage, 'utf8'), (value) =>
    isRecord(value) && typeof value['version'] === 'string' ? value['version'] : null,
  )
  if (!electron) throw new Error('Cannot read the installed Electron version')
  // `require('electron')` resolves to the binary path the e2e session launches.
  const binary: unknown = requireFromProject('electron')
  if (typeof binary !== 'string') throw new Error('Cannot resolve the Electron binary')
  const chromedriver = join(
    dirname(requireFromProject.resolve('electron-chromedriver/package.json')),
    'bin',
    'chromedriver',
  )
  return { electron, chromium: resolveElectronBrowserVersion(binary, chromedriver) }
}

/** Sorted `fc-list` output hashed, so a font package change moves the identity. */
function systemFontsDigest(): string {
  try {
    const listing = execFileSync('fc-list', [':', 'family', 'style', 'file'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    const lines = listing.split('\n').filter(Boolean).sort()
    return createHash('sha256').update(lines.join('\n')).digest('hex')
  } catch {
    return 'fc-list:unavailable'
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith('--') ? value : undefined
}

function optionList(argv: string[], name: string): string[] | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const out: string[] = []
  for (const value of argv.slice(index + 1)) {
    if (value.startsWith('--')) break
    out.push(value)
  }
  return out
}

async function prepare(): Promise<void> {
  await hydrateScreenshots()
  mkdirSync(join(ROOT, dirname(RENDER_MARKER)), { recursive: true })
  writeFileSync(join(ROOT, RENDER_MARKER), `${new Date().toISOString()}\n`)
  console.log(`Stamped ${RENDER_MARKER} after hydrating baselines`)
}

function record(argv: string[]): void {
  const shardText = option(argv, '--shard')
  const out = option(argv, '--out')
  const shard = shardText ? parseShard(shardText) : null
  if (!shard || !out)
    throw new Error(
      'Usage: screenshot-identity.mts record --shard <i>/<n> --out <file> [--specs <a b …>] [--pr-head <sha>] [--base <sha>]',
    )
  const tree = workingTree()
  const planned = optionList(argv, '--specs')
  const specs = assignShards(planned ?? listCiSpecs(tree), shard.total, readShardWeights())[
    shard.index - 1
  ]
  if (!specs) throw new Error(`Shard ${shardText ?? ''} has no slice`)
  const provenance = provenanceFromRunner(process.env, {
    shard: `${String(shard.index)}/${String(shard.total)}`,
    checkout: git(['rev-parse', 'HEAD']),
    head: option(argv, '--pr-head'),
    base: option(argv, '--base'),
  })
  if (!provenance)
    throw new Error(
      'Incomplete run provenance: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB, GITHUB_EVENT_NAME, RUNNER_NAME and RUNNER_ENVIRONMENT are required',
    )
  const versions = electronVersions()
  const environment = environmentFromRunner(process.env, {
    ...versions,
    node: process.version,
    systemFonts: systemFontsDigest(),
  })
  const manifestPath = join(ROOT, SCREENSHOT_MANIFEST)
  const baselineNames = existsSync(manifestPath)
    ? Object.keys(parseScreenshotManifest(readFileSync(manifestPath, 'utf8')).screenshots)
    : []
  const markerPath = join(ROOT, RENDER_MARKER)
  const markerMs = existsSync(markerPath) ? lstatSync(markerPath).mtimeMs : null
  const records = buildIdentityRecords({
    tree,
    specs,
    environment,
    provenance,
    hashFile,
    screenshot,
    baselineNames,
    markerMs,
  })
  mkdirSync(dirname(join(ROOT, out)), { recursive: true })
  writeFileSync(join(ROOT, out), serializeIdentityRecords(records))
  const rendered = records.records.filter((entry) => entry.result?.rendered === true).length
  console.log(
    `Recorded ${String(records.records.length)} screenshot identities from ${String(specs.length)} spec(s) ` +
      `(${String(rendered)} rendered after the marker; marker ${records.marker}; ${String(Object.keys(records.files).length)} input files) to ${out}`,
  )
}

export async function screenshotIdentity(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === 'prepare') await prepare()
  else if (command === 'record') record(rest)
  else throw new Error('Usage: screenshot-identity.mts <prepare|record> …')
}

if (isDirectExecution(import.meta.url, 'screenshot-identity'))
  void screenshotIdentity(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
