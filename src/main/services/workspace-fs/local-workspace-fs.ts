import * as fsp from 'node:fs/promises'
import type { WorkspaceFsPathProbe, WorkspaceFsStat } from './workspace-fs.ts'

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
    return fsp.realpath(path)
  },

  readFile(path: string, encoding: 'utf-8'): Promise<string> {
    return fsp.readFile(path, encoding)
  },

  readFileBytes(path: string): Promise<Buffer> {
    return fsp.readFile(path)
  },

  async writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void> {
    await fsp.writeFile(path, content, encoding)
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
