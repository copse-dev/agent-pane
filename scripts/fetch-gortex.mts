import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectRecord, nonEmptyStringOr } from '../src/shared/unknown-value.mts'

const GORTEX_VERSION = 'v0.60.0'
const REPO = 'zzet/gortex'
/** Explicit override (release lipo / isolated extract). Default: vendor/gortex in cwd. */
const OUT_DIR_OVERRIDE = process.env['GORTEX_OUT_DIR']?.trim()
const OUT_DIR = resolve(nonEmptyStringOr(OUT_DIR_OVERRIDE, 'vendor/gortex'))
/** When unset, install into ~/.copse/cache/gortex and symlink vendor/gortex → cache. */
const USE_SHARED_CACHE = OUT_DIR_OVERRIDE === undefined || OUT_DIR_OVERRIDE === ''
const BIN_NAME = process.platform === 'win32' ? 'gortex.exe' : 'gortex'
const TARGET_ARCH = nonEmptyStringOr(process.env['GORTEX_TARGET_ARCH'], process.arch)

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CHECKSUMS_PATH = join(SCRIPT_DIR, 'gortex-checksums.json')

type ChecksumManifest = Record<string, Record<string, string>>

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function loadChecksums(): Promise<ChecksumManifest> {
  try {
    const parsed = expectRecord(JSON.parse(await readFile(CHECKSUMS_PATH, 'utf8')) as unknown)
    const manifest: ChecksumManifest = {}
    for (const [version, assetsValue] of Object.entries(parsed)) {
      const assets = expectRecord(assetsValue)
      const hashes: Record<string, string> = {}
      for (const [asset, hash] of Object.entries(assets)) {
        if (typeof hash === 'string') hashes[asset] = hash
      }
      manifest[version] = hashes
    }
    return manifest
  } catch {
    return {}
  }
}

function expectedHash(manifest: ChecksumManifest, asset: string): string | null {
  const forVersion = manifest[GORTEX_VERSION]
  if (!forVersion) return null
  const value = forVersion[asset]
  return typeof value === 'string' && value.length === 64 ? value : null
}

/**
 * Verify the downloaded artifact against the committed SHA-256 manifest before
 * it is made executable. Fails closed: a missing expected hash aborts the
 * install rather than running an unverified binary (supply-chain finding L5).
 * The committed hashes come from the release's Sigstore-signed checksums.txt.
 * To record hashes after bumping GORTEX_VERSION, run on a trusted machine:
 *   UPDATE_CHECKSUMS=1 node scripts/fetch-gortex.mts
 */
async function verifyChecksum(archivePath: string, asset: string): Promise<void> {
  const manifest = await loadChecksums()
  const expected = expectedHash(manifest, asset)
  const actual = await sha256File(archivePath)

  if (process.env['UPDATE_CHECKSUMS'] === '1') {
    manifest[GORTEX_VERSION] = { ...(manifest[GORTEX_VERSION] ?? {}), [asset]: actual }
    await writeFile(CHECKSUMS_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`[fetch-gortex] UPDATE_CHECKSUMS=1 — recorded ${asset} = ${actual}`)
    return
  }

  if (!expected) {
    throw new Error(
      `no expected SHA-256 for ${GORTEX_VERSION}/${asset} in ${CHECKSUMS_PATH}. ` +
        'Refusing to install an unverified binary. On a trusted machine run ' +
        '`UPDATE_CHECKSUMS=1 node scripts/fetch-gortex.mts` to record it, ' +
        'or set SKIP_GORTEX_FETCH=1 to skip the fetch entirely.',
    )
  }

  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}. ` +
        'Aborting — the downloaded artifact does not match the committed checksum.',
    )
  }

  console.log(`[fetch-gortex] verified ${asset} SHA-256 ${actual}`)
}

function assetName(): string | null {
  if (process.platform === 'darwin' && TARGET_ARCH === 'arm64') {
    return 'gortex_darwin_arm64.tar.gz'
  }
  if (process.platform === 'darwin' && TARGET_ARCH === 'x64') {
    return 'gortex_darwin_amd64.tar.gz'
  }
  if (process.platform === 'linux' && TARGET_ARCH === 'x64') {
    return 'gortex_linux_amd64.tar.gz'
  }
  if (process.platform === 'linux' && TARGET_ARCH === 'arm64') {
    return 'gortex_linux_arm64.tar.gz'
  }
  if (process.platform === 'win32' && TARGET_ARCH === 'x64') {
    return 'gortex_windows_amd64.zip'
  }
  return null
}

/** Machine-wide cache dir for this version/platform/arch (shared across worktrees). */
function sharedGortexDir(): string {
  const override = process.env['COPSE_GORTEX_CACHE']?.trim()
  const root = override ?? join(homedir(), '.copse', 'cache', 'gortex')
  return join(root, `${GORTEX_VERSION}-${process.platform}-${TARGET_ARCH}`)
}

function sharedBinPath(): string {
  return join(sharedGortexDir(), BIN_NAME)
}

async function versionMatches(binPath: string): Promise<boolean> {
  try {
    await access(binPath)
    // Cross-arch binaries may not exec on this host (release lipo path).
    if (TARGET_ARCH !== process.arch) return true
    // gortex has no `--version` flag; the `version` subcommand exits 0 offline.
    // Require the output to name the pinned version so a GORTEX_VERSION bump
    // actually re-fetches: this used to `return true` for any working gortex,
    // so a stale binary would satisfy the check and the new version never
    // downloaded.
    const out = execFileSync(binPath, ['version'], { stdio: 'pipe' }).toString()
    return out.includes(GORTEX_VERSION.replace(/^v/, ''))
  } catch {
    return false
  }
}

async function binaryReadyAt(binPath: string): Promise<boolean> {
  // A cross-architecture binary may not be executable on this host. Release CI
  // downloads the second macOS architecture into an isolated output directory
  // and combines both verified binaries with lipo before packaging.
  if (TARGET_ARCH !== process.arch) return false
  return versionMatches(binPath)
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${String(res.status)}): ${url}`)
  if (!res.body) throw new Error(`empty response body: ${url}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

async function extract(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`,
        ],
        { stdio: 'inherit' },
      )
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' })
    }
    return
  }

  execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' })
}

async function findExtractedBinary(root: string): Promise<string | null> {
  const direct = join(root, BIN_NAME)
  try {
    await access(direct)
    return direct
  } catch {
    // Archives may nest the binary one level deep.
  }

  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = join(root, entry.name, BIN_NAME)
    try {
      await access(nested)
      return nested
    } catch {
      // keep scanning
    }
  }
  return null
}

/** Point vendor/gortex/<bin> at the shared cache binary (symlink; copy on Windows fallback). */
async function linkVendorToShared(sharedBin: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, BIN_NAME)

  try {
    const st = await lstat(outPath)
    if (st.isSymbolicLink()) {
      try {
        if ((await realpath(outPath)) === (await realpath(sharedBin))) {
          console.log(`[fetch-gortex] ${outPath} → ${sharedBin}`)
          return
        }
      } catch {
        /* broken symlink — replace */
      }
      await rm(outPath, { force: true })
    } else {
      await rm(outPath, { force: true })
    }
  } catch {
    /* missing */
  }

  try {
    await symlink(sharedBin, outPath)
    console.log(`[fetch-gortex] ${outPath} → ${sharedBin}`)
  } catch {
    // Windows without Developer Mode often cannot create file symlinks.
    await copyFile(sharedBin, outPath)
    if (process.platform !== 'win32') {
      await chmod(outPath, 0o755)
    }
    console.log(`[fetch-gortex] copied ${sharedBin} → ${outPath} (symlink unavailable)`)
  }
}

async function installBinaryFile(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const staging = `${dest}.tmp-${String(process.pid)}`
  await rm(staging, { force: true })
  await copyFile(source, staging)
  if (process.platform !== 'win32') {
    await chmod(staging, 0o755)
  }
  if (TARGET_ARCH === process.arch) {
    execFileSync(staging, ['version'], { stdio: 'inherit' })
  } else {
    console.log(`[fetch-gortex] installed verified cross-architecture binary for ${TARGET_ARCH}`)
  }
  await rm(dest, { force: true })
  await rename(staging, dest)
}

/** Promote a real (non-symlink) local binary into the shared cache if cache is empty. */
async function promoteLocalToSharedIfNeeded(sharedBin: string): Promise<boolean> {
  const localPath = join(OUT_DIR, BIN_NAME)
  try {
    const st = await lstat(localPath)
    if (st.isSymbolicLink()) return false
  } catch {
    return false
  }
  if (!(await versionMatches(localPath))) return false
  if (await versionMatches(sharedBin)) return true

  await mkdir(dirname(sharedBin), { recursive: true })
  try {
    await rename(localPath, sharedBin)
  } catch {
    await copyFile(localPath, sharedBin)
    if (process.platform !== 'win32') {
      await chmod(sharedBin, 0o755)
    }
    await rm(localPath, { force: true })
  }
  console.log(`[fetch-gortex] promoted ${localPath} → ${sharedBin}`)
  return true
}

async function ensureSharedAndLink(): Promise<'ready' | 'need-fetch'> {
  const sharedBin = sharedBinPath()
  if (await versionMatches(sharedBin)) {
    await linkVendorToShared(sharedBin)
    return 'ready'
  }
  if (await promoteLocalToSharedIfNeeded(sharedBin)) {
    await linkVendorToShared(sharedBin)
    return 'ready'
  }
  return 'need-fetch'
}

async function main(): Promise<void> {
  if (process.env['SKIP_GORTEX_FETCH'] === '1') {
    console.log('[fetch-gortex] SKIP_GORTEX_FETCH=1 — skipping')
    return
  }

  const asset = assetName()
  if (!asset) {
    console.warn(
      `[fetch-gortex] no prebuilt binary for ${process.platform}/${TARGET_ARCH} — install gortex manually or rely on vera`,
    )
    return
  }

  if (USE_SHARED_CACHE) {
    if ((await ensureSharedAndLink()) === 'ready') {
      return
    }
  } else if (await binaryReadyAt(join(OUT_DIR, BIN_NAME))) {
    console.log(`[fetch-gortex] ${join(OUT_DIR, BIN_NAME)} already present`)
    return
  }

  const url = `https://github.com/${REPO}/releases/download/${GORTEX_VERSION}/${asset}`
  const tmpRoot = join(tmpdir(), `copse-panel-gortex-${String(Date.now())}`)
  const archivePath = join(tmpRoot, asset)
  const extractDir = join(tmpRoot, 'extract')

  try {
    await mkdir(tmpRoot, { recursive: true })
    console.log(`[fetch-gortex] downloading ${asset} (${GORTEX_VERSION})`)
    await download(url, archivePath)
    // Integrity gate: verify before extracting / chmod / exec (fails closed).
    await verifyChecksum(archivePath, asset)
    if (process.env['UPDATE_CHECKSUMS'] === '1') {
      console.log('[fetch-gortex] UPDATE_CHECKSUMS=1 — checksum recorded, skipping install')
      return
    }
    await extract(archivePath, extractDir)

    const extracted = await findExtractedBinary(extractDir)
    if (!extracted) throw new Error(`could not find ${BIN_NAME} in ${asset}`)

    if (USE_SHARED_CACHE) {
      const sharedBin = sharedBinPath()
      // Another worktree may have won the race while we downloaded.
      if (!(await versionMatches(sharedBin))) {
        await installBinaryFile(extracted, sharedBin)
        console.log(`[fetch-gortex] cached ${sharedBin}`)
      } else {
        console.log(`[fetch-gortex] shared cache already populated at ${sharedBin}`)
      }
      await linkVendorToShared(sharedBin)
      const sizeMb = ((await stat(sharedBin)).size / (1024 * 1024)).toFixed(1)
      console.log(`[fetch-gortex] installed ${join(OUT_DIR, BIN_NAME)} (${sizeMb} MB, shared)`)
      return
    }

    const outPath = join(OUT_DIR, BIN_NAME)
    await installBinaryFile(extracted, outPath)
    const sizeMb = ((await stat(outPath)).size / (1024 * 1024)).toFixed(1)
    console.log(`[fetch-gortex] installed ${outPath} (${sizeMb} MB)`)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error('[fetch-gortex]', err instanceof Error ? err.message : err)
  process.exit(1)
})
