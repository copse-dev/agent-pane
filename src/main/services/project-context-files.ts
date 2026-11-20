import { constants } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { resolveInsideWithoutSymlinks } from '@copse/thread-store/environment.ts'

/** Fixed work limits keep the prototype independent of wall-clock scheduling. */
export const CONTEXT_SCAN_BYTES = 8 * 1024 * 1024
export const CONTEXT_FILE_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 4096

export class ContextFileReader {
  bytesRead = 0
  readonly omissions = new Set<string>()
  readonly signal: AbortSignal

  constructor(signal: AbortSignal) {
    this.signal = signal
  }

  async names(root: string, child: string, directories: boolean): Promise<string[]> {
    this.signal.throwIfAborted()
    const path = resolveInsideWithoutSymlinks(root, child)
    if (path === null) {
      this.omissions.add('unsafe-path')
      return []
    }
    try {
      const entries: string[] = []
      let count = 0
      for await (const entry of await opendir(path)) {
        this.signal.throwIfAborted()
        if (++count > MAX_DIRECTORY_ENTRIES) {
          // Never return an arbitrary filesystem-order prefix as a ranked corpus.
          this.omissions.add('directory-limit')
          return []
        }
        if (directories ? entry.isDirectory() : entry.isFile()) entries.push(entry.name)
        if (entry.isSymbolicLink()) this.omissions.add('unsafe-path')
      }
      return entries.sort()
    } catch {
      this.signal.throwIfAborted()
      return []
    }
  }

  async read(root: string, child: string, maxBytes = CONTEXT_FILE_BYTES): Promise<string | null> {
    this.signal.throwIfAborted()
    const path = resolveInsideWithoutSymlinks(root, child)
    if (path === null) {
      this.omissions.add('unsafe-path')
      return null
    }
    if (this.bytesRead >= CONTEXT_SCAN_BYTES) {
      this.omissions.add('scan-byte-limit')
      return null
    }
    try {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.size > BigInt(maxBytes)) {
          this.omissions.add('source-size-limit')
          return null
        }
        const size = Number(before.size)
        if (this.bytesRead + size + 1 > CONTEXT_SCAN_BYTES) {
          this.omissions.add('scan-byte-limit')
          return null
        }
        const buffer = Buffer.alloc(size + 1)
        let read = 0
        while (read < buffer.length) {
          this.signal.throwIfAborted()
          const part = await handle.read(buffer, read, buffer.length - read, read)
          if (part.bytesRead === 0) break
          read += part.bytesRead
          this.bytesRead += part.bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (
          read !== size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.size !== after.size ||
          resolveInsideWithoutSymlinks(root, child) !== path
        ) {
          this.omissions.add('source-changed')
          return null
        }
        return buffer.subarray(0, read).toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      this.signal.throwIfAborted()
      this.omissions.add('source-unavailable')
      return null
    }
  }
}
