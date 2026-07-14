import { dirname } from 'node:path'
import { posixQuote } from '../security/safe-install.ts'
import { execOnSshHost } from '../ssh-workspace/remote-fs-exec.ts'
import type { WorkspaceFsPathProbe, WorkspaceFsStat } from './workspace-fs.ts'

function remoteFsError(
  path: string,
  result: { code: number; stderr: string },
): NodeJS.ErrnoException {
  const err = new Error(
    result.stderr.trim() || `remote fs failed for ${path}`,
  ) as NodeJS.ErrnoException
  err.code = result.code === 127 ? 'ENOENT' : 'EIO'
  return err
}

/** Exec-based remote filesystem — reuses the host's POSIX tools over SSH. */
export class SshWorkspaceFs implements WorkspaceFsPathProbe {
  readonly hostId: string
  readonly remoteRoot: string

  constructor(hostId: string, remoteRoot: string) {
    this.hostId = hostId
    this.remoteRoot = remoteRoot
  }

  private async exec(
    command: string,
    stdin?: string,
  ): Promise<{ stdout: string; code: number; stderr: string }> {
    const result = await execOnSshHost(this.hostId, this.remoteRoot, command, stdin)
    return { stdout: result.stdout, code: result.code, stderr: result.stderr }
  }

  private quote(path: string): string {
    return posixQuote(path)
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${this.quote(path)}`)
    return result.code === 0
  }

  async stat(path: string): Promise<WorkspaceFsStat> {
    const result = await this.exec(
      `if [ -d ${this.quote(path)} ]; then echo d; elif [ -f ${this.quote(path)} ]; then echo f; elif [ -L ${this.quote(path)} ]; then echo l; else exit 1; fi`,
    )
    if (result.code !== 0) throw remoteFsError(path, result)
    const kind = result.stdout.trim()
    return {
      isDirectory: (): boolean => kind === 'd',
      isFile: (): boolean => kind === 'f',
      isSymbolicLink: (): boolean => kind === 'l',
    }
  }

  async lstat(path: string): Promise<WorkspaceFsStat> {
    const result = await this.exec(
      `if [ -L ${this.quote(path)} ]; then echo l; elif [ -d ${this.quote(path)} ]; then echo d; elif [ -f ${this.quote(path)} ]; then echo f; else exit 1; fi`,
    )
    if (result.code !== 0) throw remoteFsError(path, result)
    const kind = result.stdout.trim()
    return {
      isDirectory: (): boolean => kind === 'd',
      isFile: (): boolean => kind === 'f',
      isSymbolicLink: (): boolean => kind === 'l',
    }
  }

  async readlink(path: string): Promise<string> {
    const result = await this.exec(`readlink ${this.quote(path)}`)
    if (result.code !== 0) throw remoteFsError(path, result)
    return result.stdout.trimEnd()
  }

  async realpath(path: string): Promise<string> {
    const result = await this.exec(`realpath -e ${this.quote(path)}`)
    if (result.code !== 0) throw remoteFsError(path, result)
    return result.stdout.trimEnd()
  }

  async readFile(path: string, encoding: 'utf-8'): Promise<string> {
    const result = await this.exec(`cat ${this.quote(path)}`)
    if (result.code !== 0) {
      const err = remoteFsError(path, result)
      err.code = 'ENOENT'
      throw err
    }
    void encoding
    return result.stdout
  }

  async writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void> {
    void encoding
    const dir = dirname(path)
    const mkdirResult = await this.exec(`mkdir -p ${this.quote(dir)}`)
    if (mkdirResult.code !== 0) throw remoteFsError(path, mkdirResult)
    const payload = Buffer.from(content, 'utf-8').toString('base64')
    const writeResult = await this.exec(`base64 -d > ${this.quote(path)}`, payload)
    if (writeResult.code !== 0) throw remoteFsError(path, writeResult)
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flag = options?.recursive ? '-p' : ''
    const result = await this.exec(`mkdir ${flag} ${this.quote(path)}`.trim())
    if (result.code !== 0) throw remoteFsError(path, result)
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    const flags = [options?.recursive ? '-r' : '', options?.force ? '-f' : '']
      .filter(Boolean)
      .join('')
    const result = await this.exec(`rm ${flags} ${this.quote(path)}`.trim())
    if (result.code !== 0) throw remoteFsError(path, result)
  }

  async rename(from: string, to: string): Promise<void> {
    const result = await this.exec(`mv ${this.quote(from)} ${this.quote(to)}`)
    if (result.code !== 0) throw remoteFsError(from, result)
  }

  async access(path: string): Promise<void> {
    const result = await this.exec(`test -e ${this.quote(path)}`)
    if (result.code !== 0) {
      const err = remoteFsError(path, result)
      err.code = 'ENOENT'
      throw err
    }
  }

  async readdir(path: string): Promise<string[]> {
    const result = await this.exec(
      `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\n' 2>/dev/null || ls -1 ${this.quote(path)}`,
    )
    if (result.code !== 0) throw remoteFsError(path, result)
    return result.stdout.split('\n').filter(Boolean)
  }

  async readdirWithTypes(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const result = await this.exec(
      `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n' 2>/dev/null`,
    )
    if (result.code !== 0) throw remoteFsError(path, result)
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t')
        const kind = tab === -1 ? 'f' : line.slice(0, tab)
        const name = tab === -1 ? line : line.slice(tab + 1)
        return { name, isDir: kind === 'd' }
      })
  }
}

const cache = new Map<string, SshWorkspaceFs>()

export function getSshWorkspaceFs(hostId: string, remoteRoot: string): SshWorkspaceFs {
  const key = `${hostId}\0${remoteRoot}`
  let fs = cache.get(key)
  if (!fs) {
    fs = new SshWorkspaceFs(hostId, remoteRoot)
    cache.set(key, fs)
  }
  return fs
}

/** @internal test helper */
export function clearSshWorkspaceFsCacheForTest(): void {
  cache.clear()
}
