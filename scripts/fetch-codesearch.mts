import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CODESEARCH_VERSION = 'v1.0.209'
const REPO = 'flupkede/codesearch'
const OUT_DIR = resolve('vendor/codesearch')
const BIN_NAME = process.platform === 'win32' ? 'codesearch.exe' : 'codesearch'

function assetName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'codesearch-macos-arm64.tar.gz'
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'codesearch-linux-x86_64.tar.gz'
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'codesearch-windows-x86_64.zip'
  }
  return null
}

async function binaryReady(): Promise<boolean> {
  try {
    const binPath = join(OUT_DIR, BIN_NAME)
    await access(binPath)
    execFileSync(binPath, ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
  if (!res.body) throw new Error(`empty response body: ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function extract(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`],
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
  if (process.env.SKIP_CODESEARCH_FETCH === '1') {
    console.log('[fetch-codesearch] SKIP_CODESEARCH_FETCH=1 — skipping')
    return
  }

  const asset = assetName()
  if (!asset) {
    console.warn(
      `[fetch-codesearch] no prebuilt binary for ${process.platform}/${process.arch} — install codesearch manually or use MCP`,
    )
    return
  }

  if (await binaryReady()) {
    console.log(`[fetch-codesearch] ${join(OUT_DIR, BIN_NAME)} already present`)
    return
  }

  const url = `https://github.com/${REPO}/releases/download/${CODESEARCH_VERSION}/${asset}`
  const tmpRoot = join(tmpdir(), `agent-pane-codesearch-${Date.now()}`)
  const archivePath = join(tmpRoot, asset)
  const extractDir = join(tmpRoot, 'extract')

  try {
    await mkdir(tmpRoot, { recursive: true })
    console.log(`[fetch-codesearch] downloading ${asset} (${CODESEARCH_VERSION})`)
    await download(url, archivePath)
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

    execFileSync(outPath, ['--version'], { stdio: 'inherit' })
    const sizeMb = ((await stat(outPath)).size / (1024 * 1024)).toFixed(1)
    console.log(`[fetch-codesearch] installed ${outPath} (${sizeMb} MB)`)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[fetch-codesearch]', err instanceof Error ? err.message : err)
  process.exit(1)
})
