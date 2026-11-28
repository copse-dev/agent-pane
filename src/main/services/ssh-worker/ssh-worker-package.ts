import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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

interface Entry {
  path: string
  mode: number
  data: Buffer
}

function walk(root: string, dir: string, into: Entry[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(root, full, into)
    else if (stat.isFile())
      into.push({
        path: relative(root, full).split(sep).join('/'),
        mode: stat.mode & 0o755,
        data: readFileSync(full),
      })
  }
}

export function packArchive(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const header = { path: entry.path, mode: entry.mode, size: entry.data.length }
    parts.push(Buffer.from(`${JSON.stringify(header)}\n`), entry.data)
  }
  return Buffer.concat(parts)
}

export function packageFromArchive(archive: Buffer): SshWorkerPackage {
  const hash = createHash('sha256').update(archive).digest('hex')
  return { archive, hash, id: hash.slice(0, 16) }
}

/** Pack the worker from the app's own build, next to the main bundle by default. */
export function buildSshWorkerPackage(fromDir: string = __dirname): SshWorkerPackage {
  const bundle = join(fromDir, SSH_WORKER_BUNDLE)
  const entries: Entry[] = [{ path: SSH_WORKER_BUNDLE, mode: 0o644, data: readFileSync(bundle) }]
  const staging = mkdtempSync(join(tmpdir(), 'copse-ssh-worker-'))
  try {
    stageSandboxRuntime(staging, fromDir)
    walk(staging, staging, entries)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return packageFromArchive(packArchive(entries))
}
