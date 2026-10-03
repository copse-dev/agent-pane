import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../shared/safe-json.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { copseDataRoot, copseWorkspaceTmpDir } from '@copse/store-kit/copse-paths.ts'
import type {
  StorageArea,
  StorageCleanupResult,
  StorageCleanupSummary,
} from '../../shared/types/storage-cleanup.ts'

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.hasOwn(error, 'code') &&
    Reflect.get(error, 'code') === 'ENOENT'
  )
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && Reflect.get(error, 'code') === 'ESRCH')
  }
}

/** Fixed product-owned targets. Chat stores, shared dependencies and arbitrary scratch stay untouched. */
export class StorageCleanup {
  private readonly profile: string
  private readonly temp: string
  constructor(profile: string, temp: string) {
    this.profile = profile
    this.temp = temp
  }
  private paths(area: StorageArea): string[] {
    return area === 'runs'
      ? [join(this.profile, 'runtimes')]
      : [join(this.temp, 'apple-development'), join(this.temp, 'app-run')]
  }
  private get locks(): string {
    return join(this.profile, 'storage-maintenance')
  }
  private async safePath(path: string): Promise<void> {
    // The configured profile can be an alias; descendants cannot redirect cleanup.
    const roots = [this.profile, dirname(this.temp)]
    const root = roots.find((candidate) => {
      const descendant = relative(candidate, path)
      return (
        descendant !== '' &&
        !isAbsolute(descendant) &&
        descendant !== '..' &&
        !descendant.startsWith(`..${sep}`)
      )
    })
    if (!root) throw new Error('Storage target is outside its configured root')
    let current = root
    for (const part of relative(root, path).split(sep)) {
      current = join(current, part)
      const stat = await lstat(current).catch((error: unknown) => {
        if (missing(error)) return null
        throw error
      })
      if (stat?.isSymbolicLink()) throw new Error('Storage cleanup refuses redirected paths')
    }
  }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    await this.safePath(this.locks)
    await mkdir(this.locks, { recursive: true, mode: 0o700 })
    const path = join(this.locks, 'cleanup.lock')
    for (let attempt = 0; attempt < 100; attempt++) {
      const handle = await open(path, 'wx', 0o600).catch((error: unknown) => {
        if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') return null
        throw error
      })
      if (handle) {
        try {
          await handle.writeFile(String(process.pid))
          return await run()
        } finally {
          await handle.close()
          await rm(path, { force: true })
        }
      }
      // Only one contender may reap a dead owner's lock. Re-read under the
      // reaper gate so a later contender cannot unlink a freshly acquired lock.
      const reaperPath = join(this.locks, 'reaper.lock')
      const reaper = await open(reaperPath, 'wx', 0o600).catch((error: unknown) => {
        if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') return null
        throw error
      })
      if (reaper) {
        try {
          const owner = await readFile(path, 'utf8').catch((error: unknown) => {
            if (missing(error)) return ''
            throw error
          })
          if (/^[0-9]+$/.test(owner) && !alive(Number(owner))) await rm(path, { force: true })
        } finally {
          await reaper.close()
          await rm(reaperPath, { force: true })
        }
      }
      await delay(50)
    }
    throw new Error('Storage is busy. Try again when cleanup has finished.')
  }
  private async busy(area: StorageArea): Promise<boolean> {
    for (const name of await readdir(this.locks)) {
      const match = /^(runs|builds)-([0-9]+)-[a-f0-9-]+\.lease$/.exec(name)
      if (match?.[1] !== area || !match[2]) continue
      if (alive(Number(match[2]))) return true
      await rm(join(this.locks, name), { force: true })
    }
    return false
  }
  /** Persist a process lease before writing, so another Copse process cannot clean a live run. */
  async hold(area: StorageArea): Promise<() => Promise<void>> {
    const lease = join(this.locks, `${area}-${String(process.pid)}-${randomUUID()}.lease`)
    await this.locked(() => writeFile(lease, '', { mode: 0o600, flag: 'wx' }))
    return async () => {
      await rm(lease, { force: true })
    }
  }
  async use<T>(area: StorageArea, run: () => Promise<T>): Promise<T> {
    const release = await this.hold(area)
    try {
      return await run()
    } finally {
      await release()
    }
  }
  private async measure(path: string): Promise<{ bytes: number; modified: number }> {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return { bytes: 0, modified: stat.mtimeMs }
    if (!stat.isDirectory()) return { bytes: stat.size, modified: stat.mtimeMs }
    let bytes = 0
    let modified = stat.mtimeMs
    for (const name of await readdir(path)) {
      const child = await this.measure(join(path, name))
      bytes += child.bytes
      modified = Math.max(modified, child.modified)
    }
    return { bytes, modified }
  }
  private async candidates(area: StorageArea): Promise<string[]> {
    const paths: string[] = []
    for (const root of this.paths(area)) {
      await this.safePath(root)
      const names = await readdir(root).catch((error: unknown) => {
        if (missing(error)) return []
        throw error
      })
      for (const name of names) {
        // Runtime root may acquire other data in future; only run folders/archives are ours.
        if (area === 'runs' && !/^run-[a-z0-9]+-[a-f0-9]+(?:\.zip)?$/.test(name)) continue
        paths.push(join(root, name))
      }
    }
    return paths
  }
  async inspect(area: StorageArea): Promise<StorageCleanupSummary> {
    const state = await this.locked(async () => ({
      busy: await this.busy(area),
      paths: await this.candidates(area),
    }))
    if (state.busy) return { area, bytes: 0, entries: 0, busy: true }
    let bytes = 0
    for (const path of state.paths) {
      const measured = await this.measure(path).catch((error: unknown) => {
        if (missing(error)) return { bytes: 0 }
        throw error
      })
      bytes += measured.bytes
    }
    return { area, bytes, entries: state.paths.length, busy: false }
  }

  private async completedRun(path: string): Promise<boolean> {
    const runPath = path.endsWith('.zip') ? path.slice(0, -4) : path
    await this.safePath(runPath)
    const rootStat = await lstat(runPath).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (!rootStat?.isDirectory()) return false
    await this.safePath(join(runPath, 'record.json'))
    const recordStat = await lstat(join(runPath, 'record.json')).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (!recordStat?.isFile() || recordStat.size > 1_000_000) return false
    const content = await readFile(join(runPath, 'record.json'), 'utf8').catch((error: unknown) => {
      if (missing(error)) return ''
      throw error
    })
    const record = safeJsonParse(
      content,
      decodeWithSchema(
        z.object({
          finishedAt: z.number().positive(),
          teardown: z.enum(['removed', 'already-gone', 'failed']),
          cleanupError: z.string().nullable(),
        }),
      ),
    )
    return record !== null && record.teardown !== 'failed' && record.cleanupError === null
  }
  async clean(area: StorageArea, olderThan?: number): Promise<StorageCleanupResult> {
    return this.locked(async () => {
      if (await this.busy(area)) return { removed: 0, bytes: 0, skipped: 1 }
      const result = { removed: 0, bytes: 0, skipped: 0 }
      const paths = await this.candidates(area)
      const completed = new Set<string>()
      if (area === 'runs')
        for (const path of paths) {
          if (!(await lstat(path)).isSymbolicLink() && (await this.completedRun(path)))
            completed.add(path)
        }
      for (const path of paths) {
        if (area === 'runs' && !completed.has(path)) {
          result.skipped++
          continue
        }
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) {
          result.skipped++
          continue
        }
        const measured = await this.measure(path)
        if (olderThan !== undefined && measured.modified >= olderThan) {
          result.skipped++
          continue
        }
        await this.safePath(path)
        await rm(path, { recursive: true, force: true })
        result.removed++
        result.bytes += measured.bytes
      }
      return result
    })
  }
}

export function storageCleanup(): StorageCleanup {
  return new StorageCleanup(copseDataRoot(), copseWorkspaceTmpDir())
}
