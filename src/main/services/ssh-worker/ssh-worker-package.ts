import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { stageSandboxRuntime } from '../container-runtime/thread-container.ts'

/**
 * What the app uploads to an SSH host to run its worker there
 * (`docs/plans/harness-worker-roadmap.md`, R3): the self-contained worker
 * bundle (`dist/main/ssh-worker.cjs`, see `scripts/main-bundles.mts`) and the
 * sandbox runtime it loads by path, packed into one archive the host unpacks
 * with its own Node (`ssh-worker-remote.ts`).
 *
 * The archive is a run of entries, each a line of JSON
 * (`{"path","mode","size"}`) followed by that many bytes. Its hash names the
 * install directory on the host, so a host keeps one install per build and an
 * app upgrade never runs an older worker.
 */

export const SSH_WORKER_BUNDLE = 'ssh-worker.cjs'

export interface SshWorkerPackage {
  archive: Buffer
  /** sha256 of `archive`, hex. */
  hash: string
  /** The install directory's name on the host. */
  id: string
}

export interface ArchiveEntry {
  path: string
  mode: number
  data: Buffer
}

/** Every file under `dir` whose path relative to `root` `keep` accepts. */
export async function walk(
  root: string,
  dir: string,
  into: ArchiveEntry[],
  keep: (path: string) => boolean = (): boolean => true,
): Promise<void> {
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name)
    const info = await stat(full)
    const path = relative(root, full).split(sep).join('/')
    if (!keep(path)) continue
    if (info.isDirectory()) await walk(root, full, into, keep)
    else if (info.isFile())
      into.push({
        path,
        mode: info.mode & 0o755,
        data: await readFile(full),
      })
  }
}

export function packArchive(entries: readonly ArchiveEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const header = { path: entry.path, mode: entry.mode, size: entry.data.length }
    parts.push(Buffer.from(`${JSON.stringify(header)}\n`), entry.data)
  }
  return Buffer.concat(parts)
}

/**
 * The entries of an archive `packArchive` made, as one came from another
 * machine: throws on a malformed one, or one naming a path outside its root.
 */
export function readArchive(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  while (at < archive.length) {
    const end = archive.indexOf(10, at)
    if (end < 0) throw new Error('the archive is cut short')
    const header = safeJsonParse(
      archive.subarray(at, end).toString('utf8'),
      decodeWithSchema(archiveHeaderSchema),
    )
    if (header === null) throw new Error('the archive has a damaged entry')
    at = end + 1
    const parts = header.path.split('/')
    if (
      header.path.startsWith('/') ||
      parts.some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error(`the archive names a path outside its root: ${header.path}`)
    if (at + header.size > archive.length) throw new Error('the archive is cut short')
    entries.push({
      path: header.path,
      mode: header.mode,
      data: archive.subarray(at, at + header.size),
    })
    at += header.size
  }
  return entries
}

const archiveHeaderSchema = z.object({
  path: z.string().min(1).max(4096),
  mode: z.number().int().min(0),
  size: z.number().int().min(0),
})

export function packageFromArchive(archive: Buffer): SshWorkerPackage {
  const hash = createHash('sha256').update(archive).digest('hex')
  return { archive, hash, id: hash.slice(0, 16) }
}

/** Pack the worker from the app's own build, next to the main bundle by default. */
export async function buildSshWorkerPackage(
  fromDir: string = __dirname,
): Promise<SshWorkerPackage> {
  const bundle = join(fromDir, SSH_WORKER_BUNDLE)
  const entries: ArchiveEntry[] = [
    { path: SSH_WORKER_BUNDLE, mode: 0o644, data: await readFile(bundle) },
  ]
  const staging = await mkdtemp(join(tmpdir(), 'copse-ssh-worker-'))
  try {
    stageSandboxRuntime(staging, fromDir)
    await walk(staging, staging, entries)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return packageFromArchive(packArchive(entries))
}
