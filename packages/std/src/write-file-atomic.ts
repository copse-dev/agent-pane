import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { MakeDirectoryOptions, WriteFileOptions } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface WriteFileAtomicOptions {
  /** Mode for the new file (masked by the umask, like `writeFile`). */
  readonly mode?: number
  /** Encoding of string `data`; defaults to UTF-8. Ignored for bytes. */
  readonly encoding?: BufferEncoding
  /** Mode for any parent directories this call has to create. */
  readonly directoryMode?: number
  /** Flush (fsync) the data to disk before the rename makes it visible. */
  readonly flush?: boolean
}

/**
 * The temp file sits beside `path` (same filesystem, so the rename is atomic)
 * and is unique per call: two writes to one path, in this process or another,
 * never share a temp file. It is created exclusively, so it never follows or
 * reuses something already there.
 */
function temporaryPath(path: string): string {
  return `${path}.copse-${String(process.pid)}-${randomUUID()}.tmp`
}

function writeOptions(options: WriteFileAtomicOptions): WriteFileOptions {
  return {
    flag: 'wx',
    encoding: options.encoding ?? 'utf8',
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.flush === undefined ? {} : { flush: options.flush }),
  }
}

function directoryOptions(
  options: WriteFileAtomicOptions,
): MakeDirectoryOptions & { recursive: true } {
  return {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  }
}

/**
 * Replace `path` with `data` atomically: a reader sees the old contents or the
 * new, never a partial file. Creates the parent directory when it is missing,
 * writes a unique temp file beside `path`, then renames it over `path`; the
 * temp file is removed when any step fails. The result takes the temp file's
 * mode, not the replaced file's, so pass `mode` for a private file. Node-only.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(path), directoryOptions(options))
  const temporary = temporaryPath(path)
  try {
    await writeFile(temporary, data, writeOptions(options))
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Synchronous {@link writeFileAtomic}, for callers that must not yield. Node-only. */
export function writeFileAtomicSync(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  mkdirSync(dirname(path), directoryOptions(options))
  const temporary = temporaryPath(path)
  try {
    writeFileSync(temporary, data, writeOptions(options))
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Keep the original failure; a leftover temp file is harmless.
    }
    throw error
  }
}
