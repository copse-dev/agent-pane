import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GORTEX_VERSION = 'v0.58.3'
const REPO = 'zzet/gortex'
const OUT_DIR = resolve('vendor/gortex')
const BIN_NAME = process.platform === 'win32' ? 'gortex.exe' : 'gortex'

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
    return JSON.parse(await readFile(CHECKSUMS_PATH, 'utf8')) as ChecksumManifest
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
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'gortex_darwin_arm64.tar.gz'
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'gortex_linux_amd64.tar.gz'
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'gortex_windows_amd64.zip'
  }
  return null
}

async function binaryReady(): Promise<boolean> {
  try {
    const binPath = join(OUT_DIR, BIN_NAME)
    await access(binPath)
    // gortex has no `--version` flag; the `version` subcommand exits 0 offline.
    execFileSync(binPath, ['version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
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

async function main(): Promise<void> {
  if (process.env['SKIP_GORTEX_FETCH'] === '1') {
    console.log('[fetch-gortex] SKIP_GORTEX_FETCH=1 — skipping')
    return
  }

  const asset = assetName()
  if (!asset) {
    console.warn(
      `[fetch-gortex] no prebuilt binary for ${process.platform}/${process.arch} — install gortex manually or rely on vera`,
    )
    return
  }

  if (await binaryReady()) {
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

    await mkdir(OUT_DIR, { recursive: true })
    const outPath = join(OUT_DIR, BIN_NAME)
    const { copyFile } = await import('node:fs/promises')
    await rm(outPath, { force: true })
    await copyFile(extracted, outPath)
    if (process.platform !== 'win32') {
      await chmod(outPath, 0o755)
    }

    execFileSync(outPath, ['version'], { stdio: 'inherit' })
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
