import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

/**
 * Detect whether a globally installed npm ACP adapter is behind the registry
 * latest, so auto-setup can offer an approved upgrade (same Socket-Firewall
 * install path as a missing adapter).
 *
 * Version reads are local (package.json next to the resolved binary). Latest
 * comes from `npm view <pkg> version` and is best-effort — offline / registry
 * failures return null so setup continues without prompting.
 */

const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
})

/** Cache of registry "latest" lookups so Settings tab flaps don't spam npm. */
const latestCache = new Map<string, { version: string; checkedAt: number }>()

/** Re-check the registry at most this often per package (process lifetime). */
export const ACP_ADAPTER_LATEST_TTL_MS = 60 * 60 * 1000

/** Test hook — clear the in-memory latest cache. */
export function resetAcpAdapterLatestCache(): void {
  latestCache.clear()
}

/**
 * Compare two npm versions as dotted numeric tuples (prerelease / build
 * metadata stripped). Returns negative if `a < b`, 0 if equal, positive if
 * `a > b`. Non-parseable inputs compare as equal (not older) so we never
 * prompt an upgrade on garbage.
 */
export function compareNpmVersions(a: string, b: string): number {
  const left = parseNpmVersionTuple(a)
  const right = parseNpmVersionTuple(b)
  if (!left || !right) return 0
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** True when `installed` is strictly older than `latest`. */
export function isNpmVersionOlder(installed: string, latest: string): boolean {
  return compareNpmVersions(installed, latest) < 0
}

/** Strip leading `v` and anything after `-`/`+`, then split on `.`. */
export function parseNpmVersionTuple(version: string): number[] | null {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0]
  if (!core) return null
  const parts = core.split('.')
  if (parts.length === 0 || parts.some((part) => part === '' || !/^\d+$/.test(part))) return null
  return parts.map((part) => Number(part))
}

/**
 * Read the installed version of `packageName` by walking from the resolved
 * binary toward the filesystem root for a matching `package.json`. Follows
 * symlinks first (npm global bins are usually links into node_modules).
 */
export async function readInstalledNpmPackageVersion(
  binaryPath: string,
  packageName: string,
): Promise<string | null> {
  let start: string
  try {
    start = realpathSync(binaryPath)
  } catch {
    start = binaryPath
  }
  let dir = dirname(start)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'package.json')
    const version = await readPackageJsonVersion(candidate, packageName)
    if (version) return version
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function readPackageJsonVersion(
  packageJsonPath: string,
  packageName: string,
): Promise<string | null> {
  let text: string
  try {
    text = await readFile(packageJsonPath, 'utf8')
  } catch {
    return null
  }
  const parsed = safeJsonParse(text, decodeWithSchema(packageJsonSchema))
  if (!parsed || parsed.name !== packageName) return null
  return parsed.version
}

/**
 * `npm` binary that owns a global agent install — the `npm` sitting next to
 * the resolved agent binary. Falls back to PATH `npm` when the sibling is
 * missing (so a fresh install still works).
 */
export function npmBinBesideBinary(binaryPath: string): string {
  const sibling = join(dirname(binaryPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  return existsSync(sibling) ? sibling : 'npm'
}

/**
 * Latest published version of a trusted package name (`npm view <pkg> version`).
 * Returns null on timeout, non-zero exit, or empty output. Results are cached
 * for {@link ACP_ADAPTER_LATEST_TTL_MS}.
 */
export async function fetchLatestNpmPackageVersion(
  packageName: string,
  signal?: AbortSignal,
  now: number = Date.now(),
  npmBin: string = 'npm',
): Promise<string | null> {
  const cached = latestCache.get(packageName)
  if (cached && now - cached.checkedAt < ACP_ADAPTER_LATEST_TTL_MS) return cached.version

  const version = await runNpmViewVersion(npmBin, packageName, signal)
  if (!version) return null
  latestCache.set(packageName, { version, checkedAt: now })
  return version
}

function runNpmViewVersion(
  npmBin: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(npmBin, ['view', packageName, 'version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        signal,
        shell: process.platform === 'win32',
        timeout: 15_000,
      })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.on('error', () => {
      resolve(null)
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const version =
        stdout
          .trim()
          .split(/\r?\n/)
          .find((line) => line.length > 0) ?? ''
      resolve(version.length > 0 ? version : null)
    })
  })
}

export interface AcpAdapterOutdated {
  installedVersion: string
  latestVersion: string
}

/**
 * When the binary on PATH is an older install of `packageName` than the
 * registry latest, return both versions; otherwise null. Failures (missing
 * package.json, offline registry) also return null — never blocks setup.
 */
export async function detectOutdatedNpmAdapter(
  binaryPath: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<AcpAdapterOutdated | null> {
  const installedVersion = await readInstalledNpmPackageVersion(binaryPath, packageName)
  if (!installedVersion) return null
  const npmBin = npmBinBesideBinary(binaryPath)
  const latestVersion = await fetchLatestNpmPackageVersion(packageName, signal, Date.now(), npmBin)
  if (!latestVersion) return null
  if (!isNpmVersionOlder(installedVersion, latestVersion)) return null
  return { installedVersion, latestVersion }
}
