import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat as localStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { posixQuote } from '../security/safe-install.ts'
import {
  execOnSshHost,
  fetchFileOnSshHost,
  sizeOfFileOnSshHost,
} from '../ssh-workspace/remote-fs-exec.ts'
import {
  enforceWorkspaceFileSize,
  type MaterializedWorkspaceFile,
  type WorkspaceBinaryReadOptions,
  type WorkspaceFsPathProbe,
  type WorkspaceFsStat,
} from './workspace-fs.ts'

/** Two maximum-size videos can coexist while successive frame reads reuse a pull. */
const MATERIALIZED_CACHE_MAX_BYTES = 512 * 1024 * 1024
const MATERIALIZED_CACHE_TTL_MS = 5 * 60_000

interface MaterializedCacheEntry extends MaterializedWorkspaceFile {
  lastUsedAt: number
  expiresAt: number
  expiryTimer?: NodeJS.Timeout
}

const materializedFiles = new Map<string, MaterializedCacheEntry>()
const materializationFlights = new Map<string, Promise<MaterializedCacheEntry>>()
let materializationRootPromise: Promise<string> | null = null
let materializationLifecycle = new AbortController()

function materializationKey(hostId: string, remoteRoot: string, path: string): string {
  return `${hostId}\0${remoteRoot}\0${path}`
}

function materializationRoot(): Promise<string> {
  materializationRootPromise ??= mkdtemp(join(tmpdir(), 'copse-ssh-files-'))
  return materializationRootPromise
}

async function discardMaterialized(key: string, entry: MaterializedCacheEntry): Promise<void> {
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
  if (materializedFiles.get(key) === entry) materializedFiles.delete(key)
  await rm(entry.path, { force: true }).catch(() => undefined)
}

async function cachedMaterialization(
  key: string,
  sizeBytes: number,
): Promise<MaterializedCacheEntry | null> {
  const entry = materializedFiles.get(key)
  if (!entry) return null
  const now = Date.now()
  if (entry.sizeBytes !== sizeBytes || entry.expiresAt <= now) {
    await discardMaterialized(key, entry)
    return null
  }
  try {
    if ((await localStat(entry.path)).size !== sizeBytes) {
      await discardMaterialized(key, entry)
      return null
    }
  } catch {
    materializedFiles.delete(key)
    return null
  }
  entry.lastUsedAt = now
  return entry
}

async function makeCacheRoom(sizeBytes: number): Promise<void> {
  let occupied = [...materializedFiles.values()].reduce(
    (total, entry) => total + entry.sizeBytes,
    0,
  )
  if (occupied + sizeBytes <= MATERIALIZED_CACHE_MAX_BYTES) return

  const oldestFirst = [...materializedFiles.entries()].sort(
    ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
  )
  for (const [key, entry] of oldestFirst) {
    await discardMaterialized(key, entry)
    occupied -= entry.sizeBytes
    if (occupied + sizeBytes <= MATERIALIZED_CACHE_MAX_BYTES) return
  }
}

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

function nulTerminatedFields(stdout: string): string[] {
  const lastTerminator = stdout.lastIndexOf('\0')
  if (lastTerminator === -1) return []
  return stdout.slice(0, lastTerminator).split('\0')
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

  async readFile(path: string, _encoding: 'utf-8'): Promise<string> {
    const result = await this.exec(`cat ${this.quote(path)}`)
    if (result.code !== 0) {
      const err = remoteFsError(path, result)
      err.code = 'ENOENT'
      throw err
    }
    return result.stdout
  }

  async readFileBytes(path: string, options?: WorkspaceBinaryReadOptions): Promise<Buffer> {
    const materialized = await this.materializeToLocal(path, options)
    return options?.signal
      ? readFile(materialized.path, { signal: options.signal })
      : readFile(materialized.path)
  }

  async sizeOf(
    path: string,
    options?: Pick<WorkspaceBinaryReadOptions, 'signal'>,
  ): Promise<number> {
    const signal = options?.signal
    return signal
      ? sizeOfFileOnSshHost(this.hostId, this.remoteRoot, path, { signal })
      : sizeOfFileOnSshHost(this.hostId, this.remoteRoot, path)
  }

  async materializeToLocal(
    path: string,
    options?: WorkspaceBinaryReadOptions,
  ): Promise<MaterializedWorkspaceFile> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, materializationLifecycle.signal])
      : materializationLifecycle.signal
    const transferOptions = { ...options, signal }
    signal.throwIfAborted()
    const sizeBytes = await this.sizeOf(path, transferOptions)
    const maxBytes = Math.min(
      options?.maxBytes ?? MATERIALIZED_CACHE_MAX_BYTES,
      MATERIALIZED_CACHE_MAX_BYTES,
    )
    enforceWorkspaceFileSize(sizeBytes, maxBytes)
    signal.throwIfAborted()

    const key = materializationKey(this.hostId, this.remoteRoot, path)
    const cached = await cachedMaterialization(key, sizeBytes)
    if (cached) return { path: cached.path, sizeBytes: cached.sizeBytes }

    const existingFlight = materializationFlights.get(key)
    if (existingFlight) {
      const entry = await existingFlight
      return { path: entry.path, sizeBytes: entry.sizeBytes }
    }

    const flight = this.fetchMaterialization(key, path, sizeBytes, maxBytes, transferOptions)
    materializationFlights.set(key, flight)
    try {
      const entry = await flight
      return { path: entry.path, sizeBytes: entry.sizeBytes }
    } finally {
      if (materializationFlights.get(key) === flight) materializationFlights.delete(key)
    }
  }

  private async fetchMaterialization(
    key: string,
    remotePath: string,
    expectedSize: number,
    maxBytes: number,
    options: WorkspaceBinaryReadOptions | undefined,
  ): Promise<MaterializedCacheEntry> {
    const root = await materializationRoot()
    const localPath = join(root, `${randomUUID()}${extname(remotePath)}`)
    try {
      await fetchFileOnSshHost(this.hostId, this.remoteRoot, remotePath, localPath, {
        ...options,
        maxBytes,
      })
      const transferredSize = (await localStat(localPath)).size
      if (transferredSize !== expectedSize) {
        throw new Error(
          `Remote file changed while it was being transferred (${String(expectedSize)} bytes became ${String(transferredSize)} bytes)`,
        )
      }
      await makeCacheRoom(transferredSize)
      const now = Date.now()
      const entry: MaterializedCacheEntry = {
        path: localPath,
        sizeBytes: transferredSize,
        lastUsedAt: now,
        expiresAt: now + MATERIALIZED_CACHE_TTL_MS,
      }
      entry.expiryTimer = setTimeout(() => {
        void discardMaterialized(key, entry)
      }, MATERIALIZED_CACHE_TTL_MS)
      entry.expiryTimer.unref()
      materializedFiles.set(key, entry)
      return entry
    } catch (error) {
      await rm(localPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async writeFile(path: string, content: string, _encoding: 'utf-8'): Promise<void> {
    const dir = dirname(path)
    const mkdirResult = await this.exec(`mkdir -p ${this.quote(dir)}`)
    if (mkdirResult.code !== 0) throw remoteFsError(path, mkdirResult)
    const payload = Buffer.from(content, 'utf-8').toString('base64')
    const writeResult = await this.exec(`base64 -d > ${this.quote(path)}`, payload)
    if (writeResult.code !== 0) throw remoteFsError(path, writeResult)
  }

  async writeFileBytes(path: string, content: Buffer): Promise<void> {
    const dir = dirname(path)
    const mkdirResult = await this.exec(`mkdir -p ${this.quote(dir)}`)
    if (mkdirResult.code !== 0) throw remoteFsError(path, mkdirResult)
    const writeResult = await this.exec(
      `base64 -d > ${this.quote(path)}`,
      content.toString('base64'),
    )
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
      .join(' ')
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
    const gnuFind = await this.exec(
      `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\0' 2>/dev/null`,
    )
    const result =
      gnuFind.code === 0
        ? gnuFind
        : await this.exec(
            `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -exec sh -c 'for p do printf "%s\\000" "\${p##*/}"; done' sh {} +`,
          )
    if (result.code !== 0) throw remoteFsError(path, result)
    return nulTerminatedFields(result.stdout)
  }

  async readdirWithTypes(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const gnuFind = await this.exec(
      `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\0%f\\0' 2>/dev/null`,
    )
    const result =
      gnuFind.code === 0
        ? gnuFind
        : await this.exec(
            `find ${this.quote(path)} -mindepth 1 -maxdepth 1 -exec sh -c 'for p do if [ -d "$p" ]; then printf "d\\000%s\\000" "\${p##*/}"; else printf "f\\000%s\\000" "\${p##*/}"; fi; done' sh {} +`,
          )
    if (result.code !== 0) throw remoteFsError(path, result)
    const fields = nulTerminatedFields(result.stdout)
    const entries: Array<{ name: string; isDir: boolean }> = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const kind = fields[index]
      const name = fields[index + 1]
      if (kind === undefined || name === undefined) break
      entries.push({ name, isDir: kind === 'd' })
    }
    return entries
  }
}

const workspaceFsCache = new Map<string, SshWorkspaceFs>()

export function getSshWorkspaceFs(hostId: string, remoteRoot: string): SshWorkspaceFs {
  const key = `${hostId}\0${remoteRoot}`
  let fs = workspaceFsCache.get(key)
  if (!fs) {
    fs = new SshWorkspaceFs(hostId, remoteRoot)
    workspaceFsCache.set(key, fs)
  }
  return fs
}

/** Drop cached workspace instances and securely-scoped local copies of remote files. */
export async function clearSshWorkspaceFsCache(): Promise<void> {
  workspaceFsCache.clear()
  const lifecycle = materializationLifecycle
  materializationLifecycle = new AbortController()
  lifecycle.abort()
  await Promise.allSettled([...materializationFlights.values()])
  materializationFlights.clear()
  for (const entry of materializedFiles.values()) {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
  }
  materializedFiles.clear()
  const rootPromise = materializationRootPromise
  materializationRootPromise = null
  if (!rootPromise) return
  const root = await rootPromise.catch(() => null)
  if (root) await rm(root, { recursive: true, force: true })
}

/** @internal test helper */
export function clearSshWorkspaceFsCacheForTest(): Promise<void> {
  return clearSshWorkspaceFsCache()
}
