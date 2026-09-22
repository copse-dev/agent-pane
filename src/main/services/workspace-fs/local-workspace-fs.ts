import { realpathSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import {
  enforceWorkspaceFileSize,
  type MaterializedWorkspaceFile,
  type WorkspaceBinaryReadOptions,
  type WorkspaceFsPathProbe,
  type WorkspaceFsStat,
} from './workspace-fs.ts'

/** Local disk implementation — current node:fs/promises behavior. */
export const localWorkspaceFs: WorkspaceFsPathProbe = {
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  },

  async stat(path: string): Promise<WorkspaceFsStat> {
    const stat = await fsp.stat(path)
    return {
      isDirectory: (): boolean => stat.isDirectory(),
      isFile: (): boolean => stat.isFile(),
      isSymbolicLink: (): boolean => stat.isSymbolicLink(),
    }
  },

  async lstat(path: string): Promise<WorkspaceFsStat> {
    const stat = await fsp.lstat(path)
    return {
      isDirectory: (): boolean => stat.isDirectory(),
      isFile: (): boolean => stat.isFile(),
      isSymbolicLink: (): boolean => stat.isSymbolicLink(),
    }
  },

  readlink(path: string): Promise<string> {
    return fsp.readlink(path)
  },

  realpath(path: string): Promise<string> {
    // Match the pre-3a sync helpers (`realpathSync.native`) for macOS symlink
    // canonicalization (/var → /private/var); `fsp.realpath` can diverge.
    return Promise.resolve(realpathSync.native(path))
  },

  readFile(path: string, encoding: 'utf-8'): Promise<string> {
    return fsp.readFile(path, encoding)
  },

  async readFileBytes(path: string, options?: WorkspaceBinaryReadOptions): Promise<Buffer> {
    const maxBytes = options?.maxBytes
    if (maxBytes === undefined) {
      return options?.signal ? fsp.readFile(path, { signal: options.signal }) : fsp.readFile(path)
    }
    options?.signal?.throwIfAborted()
    const file = await fsp.open(path, 'r')
    try {
      enforceWorkspaceFileSize((await file.stat()).size, maxBytes)
      const chunks: Buffer[] = []
      let size = 0
      while (size <= maxBytes) {
        options?.signal?.throwIfAborted()
        // The extra byte proves overflow without reading the rest of a growing
        // file. One open handle also prevents a path replacement after stat
        // from redirecting this read to a different, potentially much larger file.
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size))
        const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null)
        if (bytesRead === 0) break
        size += bytesRead
        enforceWorkspaceFileSize(size, maxBytes)
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks, size)
    } finally {
      await file.close()
    }
  },

  async sizeOf(path: string, options?: { signal?: AbortSignal }): Promise<number> {
    options?.signal?.throwIfAborted()
    const size = (await fsp.stat(path)).size
    options?.signal?.throwIfAborted()
    return size
  },

  async materializeToLocal(
    path: string,
    options?: WorkspaceBinaryReadOptions,
  ): Promise<MaterializedWorkspaceFile> {
    const sizeBytes = await this.sizeOf(path, options)
    enforceWorkspaceFileSize(sizeBytes, options?.maxBytes)
    return { path, sizeBytes }
  },

  async writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void> {
    await fsp.writeFile(path, content, encoding)
  },

  async writeFileBytes(path: string, content: Buffer): Promise<void> {
    await fsp.writeFile(path, content)
  },

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return fsp.mkdir(path, options).then(() => undefined)
  },

  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    return fsp.rm(path, options).then(() => undefined)
  },

  rename(from: string, to: string): Promise<void> {
    return fsp.rename(from, to).then(() => undefined)
  },

  access(path: string): Promise<void> {
    return fsp.access(path)
  },

  readdir(path: string): Promise<string[]> {
    return fsp.readdir(path)
  },

  async readdirWithTypes(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const dirents = await fsp.readdir(path, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  },
}
