import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

export const DESKTOP_LEASE_LABEL = 'dev.copse.isolated-desktop'
const nameSchema = z.string().regex(/^copse-desktop-probe-[a-f0-9-]{36}$/)
const leaseSchema = z
  .object({
    version: z.literal(1),
    name: nameSchema,
    nonce: z.uuid(),
    pid: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
const inspectSchema = z
  .array(
    z.object({
      configuration: z.object({ labels: z.record(z.string(), z.string()) }),
    }),
  )
  .length(1)

interface LeaseEngine {
  inspect: (name: string) => Promise<string | null>
  remove: (name: string) => Promise<void>
}
interface LeaseProcess {
  pid: number
  isAlive: (pid: number) => boolean
  now: () => number
}

/** Persist before engine creation; delete only after engine deletion, including lost replies. */
export class DesktopLeaseRecovery {
  private readonly directory: string
  private readonly engine: LeaseEngine
  private readonly owner: LeaseProcess
  constructor(directory: string, engine: LeaseEngine, owner: LeaseProcess) {
    this.directory = directory
    this.engine = engine
    this.owner = owner
  }

  async begin(name: string): Promise<string> {
    nameSchema.parse(name)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const temporary = join(this.directory, '.lease-' + randomUUID() + '.tmp')
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          name,
          nonce,
          pid: this.owner.pid,
          expiresAt: this.owner.now() + 15 * 60_000,
        }),
        { mode: 0o600, flag: 'wx' },
      )
      await rename(temporary, join(this.directory, name + '.json'))
    } finally {
      await rm(temporary, { force: true })
    }
    return nonce
  }

  async forget(name: string): Promise<void> {
    nameSchema.parse(name)
    await rm(join(this.directory, name + '.json'), { force: true })
  }

  async recover(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') return
      throw error
    }
    if (names.length > 256) throw new Error('Too many isolated desktop recovery records')
    for (const filename of names) {
      if (!filename.endsWith('.json')) continue
      const name = filename.slice(0, -5)
      nameSchema.parse(name)
      const file = await open(
        join(this.directory, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      let text: string
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid desktop recovery record')
        text = await file.readFile('utf8')
      } finally {
        await file.close()
      }
      const lease = safeJsonParse(text, decodeWithSchema(leaseSchema))
      if (!lease || lease.name !== name) throw new Error('Invalid desktop recovery record')
      if (lease.expiresAt > this.owner.now() && this.owner.isAlive(lease.pid)) continue
      const inspected = await this.engine.inspect(name)
      if (inspected !== null) {
        const config = safeJsonParse(inspected, decodeWithSchema(inspectSchema))
        if (config?.[0]?.configuration.labels[DESKTOP_LEASE_LABEL] !== lease.nonce)
          throw new Error('Refusing to delete a desktop with mismatched recovery ownership')
        await this.engine.remove(name)
      }
      await this.forget(name)
    }
  }
}

const exec = promisify(execFile)
async function command(args: string[]): Promise<string> {
  return (
    await exec('/usr/local/bin/container', args, {
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    })
  ).stdout
}
const leases = new DesktopLeaseRecovery(
  join(copseDataRoot(), 'isolated-desktops'),
  {
    async inspect(name): Promise<string | null> {
      try {
        return await command(['inspect', name])
      } catch (error) {
        // Only an explicit missing-container result permits forgetting a lost-create record.
        if (
          isRecord(error) &&
          typeof error['stderr'] === 'string' &&
          error['stderr'].includes(name) &&
          /not found|does not exist/i.test(error['stderr'])
        )
          return null
        throw error
      }
    },
    async remove(name): Promise<void> {
      await command(['delete', '--force', name])
    },
  },
  {
    pid: process.pid,
    now: Date.now,
    isAlive(pid): boolean {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return !(isRecord(error) && error['code'] === 'ESRCH')
      }
    },
  },
)

export const beginDesktopLease = (name: string): Promise<string> => leases.begin(name)
export const forgetDesktopLease = (name: string): Promise<void> => leases.forget(name)
let recovery: Promise<void> | undefined
export function recoverIsolatedDesktops(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return Promise.resolve()
  recovery ??= leases.recover().finally(() => {
    recovery = undefined
  })
  return recovery
}
