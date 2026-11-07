import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../shared/safe-json.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
    // A filesystem bakery lock: owner identity is in each unique filename, so
    // even a crash before publishing a ticket is reclaimable. Reaping touches
    // only that dead owner's unique claim; there is no reusable reaper gate
    // whose stale deletion could race a newly acquired owner.
    const owner = `${String(process.pid)}-${randomUUID()}`
    const choosing = join(this.locks, `choosing-${owner}.lock`)
    let claim = choosing
    await writeFile(choosing, '', { flag: 'wx', mode: 0o600 })
    try {
      let highest = 0n
      for (const name of await readdir(this.locks)) {
        const ticket = /^ticket-([0-9]{1,64})-[0-9]+-[a-f0-9-]+\.lock$/.exec(name)
        if (ticket?.[1]) highest = BigInt(ticket[1]) > highest ? BigInt(ticket[1]) : highest
      }
      const number = highest + 1n
      if (String(number).length > 64) throw new Error('Storage lock ticket is out of range')
      claim = join(this.locks, `ticket-${String(number)}-${owner}.lock`)
      await rename(choosing, claim)
      for (let attempt = 0; attempt < 100; attempt++) {
        let blocked = false
        for (const name of await readdir(this.locks)) {
          const ticket = /^ticket-([0-9]{1,64})-([0-9]+)-([a-f0-9-]+)\.lock$/.exec(name)
          const selecting = /^choosing-([0-9]+)-([a-f0-9-]+)\.lock$/.exec(name)
          const pid = ticket?.[2] ?? selecting?.[1]
          if (!pid) continue
          const path = join(this.locks, name)
          if (path === claim) continue
          if (!alive(Number(pid))) {
            await rm(path, { force: true })
            continue
          }
          // Wait for every live chooser; it may publish an earlier ticket.
          if (selecting) blocked = true
          if (ticket?.[1] && ticket[2] && ticket[3]) {
            const otherNumber = BigInt(ticket[1])
            const otherOwner = `${ticket[2]}-${ticket[3]}`
            if (otherNumber < number || (otherNumber === number && otherOwner < owner))
              blocked = true
          }
        }
        if (!blocked) return await run()
        await delay(50)
      }
      throw new Error('Storage is busy. Try again when cleanup has finished.')
    } finally {
      await rm(claim, { force: true })
      // If ticket publication failed, the choosing claim still belongs to us.
      await rm(choosing, { force: true })
    }
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
  /** Hold the gate while acting on a shared resource; new users wait until cleanup finishes. */
  async whenIdle<T>(areas: readonly StorageArea[], run: () => Promise<T>): Promise<T | null> {
    return this.locked(async () => {
      for (const area of areas) if (await this.busy(area)) return null
      return run()
    })
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
      // Completed directories and their archives are one retention unit. A
      // newer archive must keep its directory alive until both can expire.
      const groups = new Map<string, string[]>()
      for (const path of paths) {
        const key = area === 'runs' && path.endsWith('.zip') ? path.slice(0, -4) : path
        const group = groups.get(key) ?? []
        group.push(path)
        groups.set(key, group)
      }
      for (const [runPath, group] of groups) {
        if (
          area === 'runs' &&
          ((
            await lstat(runPath).catch((error: unknown) => {
              if (missing(error)) return null
              throw error
            })
          )?.isSymbolicLink() ||
            !(await this.completedRun(runPath)))
        ) {
          result.skipped += group.length
          continue
        }
        const measurements: { path: string; bytes: number; modified: number }[] = []
        let redirected = false
        for (const path of group) {
          if ((await lstat(path)).isSymbolicLink()) {
            redirected = true
            break
          }
          await this.safePath(path)
          measurements.push({ path, ...(await this.measure(path)) })
        }
        if (
          redirected ||
          (olderThan !== undefined && measurements.some((entry) => entry.modified >= olderThan))
        ) {
          result.skipped += group.length
          continue
        }
        // Remove archives first so a failed directory removal remains eligible
        // for a later pass rather than stranding an archive without its record.
        measurements.sort(
          (a, b) => Number(b.path.endsWith('.zip')) - Number(a.path.endsWith('.zip')),
        )
        for (const entry of measurements) {
          await rm(entry.path, { recursive: true, force: true })
          result.removed++
          result.bytes += entry.bytes
        }
      }
      return result
    })
  }
}

export function storageCleanup(): StorageCleanup {
  return new StorageCleanup(copseDataRoot(), copseWorkspaceTmpDir())
}
