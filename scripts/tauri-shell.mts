/**
 * The prebuilt Tauri + Servo shell: fetch it, cache it, hand back its path.
 *
 * The shell is built in copse-dev/tauri-shell, which is public, so compiling
 * Servo happens on free runner minutes. This repository is private and would
 * be billed for the same twenty-plus minutes on every run, so it downloads a
 * release binary instead and never invokes cargo at all.
 *
 * Cached under ~/.copse/cache, alongside the electron dist and the vendored
 * gortex, so worktrees share one copy.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectRecord } from '../src/shared/unknown-value.mts'

/**
 * The release this repository is pinned to.
 *
 * Moving it is a deliberate act: the shell freezes the stdio protocol in
 * src/sidecar/shell-link.ts, so a bump and a protocol change belong in the
 * same pull request.
 */
export const SHELL_RELEASE = 'v0.1.1'
const REPO = 'copse-dev/tauri-shell'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CHECKSUMS_PATH = join(SCRIPT_DIR, 'tauri-shell-checksums.json')

/** Release asset names, keyed by `${process.platform}-${process.arch}`. */
const ASSETS: Record<string, string> = {
  'darwin-arm64': 'tauri-shell-macos-aarch64.tar.gz',
  'linux-x64': 'tauri-shell-linux-x86_64.tar.gz',
}

function assetFor(platform = process.platform, arch = process.arch): string {
  const key = `${platform}-${arch}`
  const asset = ASSETS[key]
  if (asset === undefined) {
    throw new Error(
      `no tauri-shell release asset for ${key} — the shell is built for ${Object.keys(ASSETS).join(
        ' and ',
      )}. ` + `Add the target to .github/workflows/release.yml in ${REPO} first.`,
    )
  }
  return asset
}

async function expectedSha(asset: string): Promise<string> {
  // Verified against a manifest committed here, not against the checksum file
  // published beside the asset: anything able to swap the one could swap the
  // other. A tag with no entry fails closed rather than downloading blind.
  let releases: Record<string, unknown>
  try {
    releases = expectRecord(JSON.parse(await readFile(CHECKSUMS_PATH, 'utf8')) as unknown)
  } catch {
    throw new Error(`cannot read ${CHECKSUMS_PATH}`)
  }
  const forRelease = releases[SHELL_RELEASE]
  const sha = forRelease === undefined ? undefined : expectRecord(forRelease)[asset]
  if (typeof sha !== 'string') {
    throw new Error(
      `no checksum recorded for ${asset} at ${SHELL_RELEASE} in scripts/tauri-shell-checksums.json. ` +
        `Add it from the release's published .sha256 before pinning this version.`,
    )
  }
  return sha
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path to the shell binary, downloading it on first use.
 *
 * `COPSE_TAURI_SHELL_BIN` overrides entirely, for running a locally built
 * shell against this checkout — which is how you would develop the shell
 * itself.
 */
export async function ensureTauriShell(): Promise<string> {
  const override = process.env['COPSE_TAURI_SHELL_BIN']?.trim()
  if (override !== undefined && override !== '') return resolve(override)

  const asset = assetFor()
  const cacheDir = join(homedir(), '.copse', 'cache', 'tauri-shell', SHELL_RELEASE)
  const binary = join(cacheDir, 'tauri-shell')
  if (await exists(binary)) return binary

  const sha = await expectedSha(asset)
  const url = `https://github.com/${REPO}/releases/download/${SHELL_RELEASE}/${asset}`
  console.log(`[tauri-shell] downloading ${SHELL_RELEASE} ${asset}`)

  const staging = await mkdtemp(join(tmpdir(), 'tauri-shell-'))
  try {
    const archive = join(staging, asset)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`${url} → HTTP ${String(response.status)}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha) {
      throw new Error(`checksum mismatch for ${asset}: expected ${sha}, got ${actual}`)
    }
    await writeFile(archive, bytes)
    execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' })
    const extracted = join(staging, 'tauri-shell')
    await chmod(extracted, 0o755)
    await mkdir(cacheDir, { recursive: true })
    // Rename last: a half-extracted directory must never look like a cache hit.
    await rename(extracted, binary)
    return binary
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
