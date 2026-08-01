import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { formatByteSize } from '@shared/file-bytes.ts'
import { isUnsafeEntryPath, readZipDirectory, readZipEntry } from '../storage/zip-reader.ts'
import { threadBlobsDir } from '../thread-store.ts'

/**
 * Unpack a zip into the thread that asked for it, so the agent can then read it
 * with the ordinary file tools.
 *
 * The extraction root is inside the thread's own directory in the chat store.
 * That is the whole trick: `resolveReadablePath` already accepts absolute paths
 * under the chat store, so extracted files are readable by `read_file`,
 * `list_dir`, `search_code` and `explore` the moment they exist — no new path
 * authority, nothing to clean up on a timer, and the files disappear with the
 * thread. It is the same arrangement dropped videos use (`blobs/media/`).
 *
 * Everything about an archive is attacker-controlled: entry names, entry count,
 * and the ratio between what it claims to be and what it expands to. The caps
 * below are all about that, not about the format.
 */

/** Sub-directory of a thread's blobs where archives are unpacked. */
const ARCHIVES_DIR = 'archives'

/** Entries one archive may contain. Well past any plausible attachment. */
export const MAX_ARCHIVE_ENTRIES = 20_000

/** Total bytes one archive may expand to on disk. */
export const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024

/**
 * Largest expansion factor an archive may reach before extraction stops.
 *
 * A zip bomb is a small file that decompresses to a colossal one — the classic
 * is a few dozen KB expanding to petabytes, ratios in the millions. Ordinary
 * content is nowhere near: source trees and JSON land around 3–10x, and even a
 * file of repeated zeroes rarely justifies 200x in something a user meant to
 * send. Checked as it extracts, not at the end, so the bomb never lands.
 */
export const MAX_COMPRESSION_RATIO = 200

export interface ExtractedFile {
  /** Path relative to the extraction root, POSIX-separated. */
  path: string
  sizeBytes: number
}

export interface SkippedEntry {
  path: string
  reason: string
}

export interface ExtractedArchive {
  /** Absolute directory the archive was unpacked into. */
  root: string
  files: ExtractedFile[]
  /** Entries deliberately not written, each with why. */
  skipped: SkippedEntry[]
  /** True when a cap stopped extraction before the archive was exhausted. */
  truncated: boolean
  /** True when the archive was already unpacked and this call reused it. */
  reused: boolean
}

/** Longest human-readable part of an extraction directory name. */
const MAX_NAME_CHARS = 60

/**
 * A stored attachment is written as `<uuid>-<original name>` so two drops of
 * `release.zip` cannot collide. That prefix is 37 characters of noise here: it
 * would eat most of the budget below and truncate away the part a person (or a
 * model quoting the path back) actually recognises.
 */
const STORED_ATTACHMENT_UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i

/** Keep a directory name derived from an archive's filename free of anything path-like. */
function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const withoutUuid = base.replace(STORED_ATTACHMENT_UUID_PREFIX, '')
  const safe = withoutUuid
    .replace(/\.zip$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, '')
  return safe || 'archive'
}

/** Re-list a directory that a previous call already unpacked. */
async function listExtracted(root: string): Promise<ExtractedFile[]> {
  const dirents = await readdir(root, { withFileTypes: true, recursive: true })
  return dirents
    .filter((dirent) => dirent.isFile())
    .map((dirent) => {
      const full = join(dirent.parentPath, dirent.name)
      return { path: relative(root, full).split(sep).join('/'), sizeBytes: statSync(full).size }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

export interface ExtractArchiveInput {
  projectId: string
  threadId: string
  /** Original archive filename, used only to name the extraction directory. */
  name: string
  bytes: Uint8Array
  /** Aborting mid-extraction discards the staging directory rather than half-unpacking. */
  signal?: AbortSignal
}

/**
 * Unpack `bytes` into the thread and describe what landed.
 *
 * The directory is named for the archive plus a hash of its contents, so
 * unpacking the same archive twice reuses the first result (cheap re-reads
 * across turns) while a changed archive of the same name gets its own.
 */
export async function extractArchiveForThread(
  input: ExtractArchiveInput,
): Promise<ExtractedArchive> {
  const digest = createHash('sha256').update(input.bytes).digest('hex').slice(0, 12)
  const root = join(
    threadBlobsDir(input.projectId, input.threadId),
    ARCHIVES_DIR,
    `${sanitizeName(input.name)}-${digest}`,
  )
  if (existsSync(root)) {
    return { root, files: await listExtracted(root), skipped: [], truncated: false, reused: true }
  }

  const entries = readZipDirectory(input.bytes)
  const files: ExtractedFile[] = []
  const skipped: SkippedEntry[] = []
  let truncated = false
  let totalBytes = 0

  // Unpack into a sibling and rename, so a crash or a cap tripping mid-way
  // never leaves a half-archive at the path a later call would reuse.
  const staging = `${root}.partial`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    for (const entry of entries) {
      if (input.signal?.aborted === true) throw new Error('Extraction cancelled.')
      if (files.length >= MAX_ARCHIVE_ENTRIES) {
        truncated = true
        break
      }
      if (entry.isDirectory) continue
      if (entry.isSymlink) {
        skipped.push({ path: entry.path, reason: 'symlink' })
        continue
      }
      if (isUnsafeEntryPath(entry.path)) {
        skipped.push({ path: entry.path, reason: 'path escapes the archive root' })
        continue
      }
      if (totalBytes + entry.uncompressedSize > MAX_EXTRACTED_BYTES) {
        truncated = true
        break
      }
      const data = await readZipEntry(input.bytes, entry)
      totalBytes += data.length
      if (totalBytes > input.bytes.length * MAX_COMPRESSION_RATIO) {
        throw new Error(
          `This archive expands to more than ${String(MAX_COMPRESSION_RATIO)}x its size (${formatByteSize(totalBytes)} so far from ${formatByteSize(input.bytes.length)}) and was not extracted.`,
        )
      }
      const target = join(staging, ...entry.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      await writeFile(target, data)
      files.push({ path: entry.path, sizeBytes: data.length })
    }
    renameSync(staging, root)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { root, files, skipped, truncated, reused: false }
}
