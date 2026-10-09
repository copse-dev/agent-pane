import { emptyContainerStorage } from '../../shared/types/storage-cleanup.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../shared/safe-json.ts'
import { errorMessage } from '../../shared/errors.ts'
import type {
  ContainerStorageAction,
  ContainerStorageSummary,
  StorageCleanupResult,
} from '../../shared/types/storage-cleanup.ts'
import {
  appleContainerActivity,
  appleImageLastUsed,
  withAppleBuilderLock,
} from './container-runtime/apple-container-activity.ts'

const exec = promisify(execFile)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const imagesSchema = z.array(
  z.object({
    configuration: z.object({ name: z.string(), creationDate: z.string() }),
    variants: z.array(
      z.object({
        digest,
        size: z.number().nonnegative(),
        config: z.object({
          config: z.object({ Labels: z.record(z.string(), z.string()).optional() }),
        }),
      }),
    ),
  }),
)
const containersSchema = z.array(
  z.object({
    id: z.string(),
    configuration: z.object({ labels: z.record(z.string(), z.string()).optional() }),
    status: z.object({ state: z.string() }),
  }),
)

const cacheSchema = z
  .array(z.object({ size: z.number().nonnegative(), inUse: z.boolean() }))
  .nullable()
  .transform((records) => records ?? [])

async function allocated(path: string): Promise<number> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  })
  if (!stat || stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.blocks * 512
  let bytes = stat.blocks * 512
  for (const name of await readdir(path)) bytes += await allocated(join(path, name))
  return bytes
}

interface Dependencies {
  supported: boolean
  root: string
  run: (args: string[]) => Promise<string>
  lastUsed: (name: string) => Promise<number>
  exclusive: <T>(run: () => Promise<T>) => Promise<T | null>
}

/** Commands own deletion. Never remove Apple's sparse ext4 files directly. */
export class ContainerStorage {
  private readonly dependencies: Dependencies
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
  }
  private async inventory(): Promise<{
    images: z.infer<typeof imagesSchema>
    containers: z.infer<typeof containersSchema>
    builder: z.infer<typeof containersSchema>[number] | undefined
    busy: boolean
  }> {
    const [imageText, containerText] = await Promise.all([
      this.dependencies.run(['image', 'list', '--format', 'json']),
      this.dependencies.run(['list', '--all', '--format', 'json']),
    ])
    const images = safeJsonParse(imageText, decodeWithSchema(imagesSchema))
    const containers = safeJsonParse(containerText, decodeWithSchema(containersSchema))
    if (!images || !containers)
      throw new Error('Apple container returned an unsupported storage inventory')
    const builder = containers.find(
      (entry) =>
        entry.id === 'buildkit' &&
        entry.configuration.labels?.['com.apple.container.resource.role'] === 'builder',
    )
    return { images, containers, builder, busy: containers.some((entry) => entry !== builder) }
  }
  private async builderCache(): Promise<z.infer<typeof cacheSchema>> {
    const text = await this.dependencies.run([
      'exec',
      'buildkit',
      'buildctl',
      'du',
      '--format',
      '{{json .}}',
    ])
    const records = safeJsonParse(text, decodeWithSchema(cacheSchema))
    if (!records) throw new Error('Apple builder returned unsupported cache usage')
    return records
  }
  async inspect(): Promise<ContainerStorageSummary> {
    const summary = emptyContainerStorage()
    if (!this.dependencies.supported) return summary
    try {
      const root = this.dependencies.root
      const sizes = await Promise.all(
        ['snapshots', 'content', 'containers', 'volumes'].map((name) =>
          allocated(join(root, name)),
        ),
      )
      summary.snapshotsBytes = sizes[0] ?? 0
      summary.blobsBytes = sizes[1] ?? 0
      summary.containersBytes = sizes[2] ?? 0
      summary.builderDiskBytes = await allocated(join(root, 'containers', 'buildkit'))
      summary.volumesBytes = sizes[3] ?? 0
      summary.totalBytes = await allocated(root)
      summary.otherBytes = Math.max(0, summary.totalBytes - sizes.reduce((a, b) => a + b, 0))
      const snapshots = await readdir(join(root, 'snapshots')).catch((error: unknown) => {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return []
        throw error
      })
      const snapshotIds = snapshots.filter((name) => /^[a-f0-9]{64}$/.test(name))
      summary.snapshotCount = snapshotIds.length
      const inventory = await this.inventory()
      summary.available = true
      summary.busy = inventory.busy
      summary.builderRunning = inventory.builder?.status.state === 'running'
      const referenced = new Set(
        inventory.images.flatMap((image) =>
          image.variants.map((variant) => variant.digest.slice(7)),
        ),
      )
      summary.unmatchedSnapshots = snapshotIds.filter((id) => !referenced.has(id)).length
      if (summary.builderRunning) {
        try {
          const cache = await this.builderCache()
          summary.builderCacheBytes = cache.reduce((sum, entry) => sum + entry.size, 0)
          summary.builderReclaimableBytes = cache
            .filter((entry) => !entry.inUse)
            .reduce((sum, entry) => sum + entry.size, 0)
          summary.busy ||= cache.some((entry) => entry.inUse)
        } catch (error) {
          summary.error = `Builder cache usage unavailable: ${errorMessage(error)}`
        }
      }
      summary.images = await Promise.all(
        inventory.images.map(async (image) => ({
          name: image.configuration.name,
          bytes: image.variants.reduce((sum, variant) => sum + variant.size, 0),
          snapshotBytes: (
            await Promise.all(
              image.variants.map((variant) =>
                allocated(join(root, 'snapshots', variant.digest.slice(7))),
              ),
            )
          ).reduce((a, b) => a + b, 0),
          eligible: this.ownedExtraImage(image),
        })),
      )
    } catch (error) {
      summary.error = errorMessage(error)
    }
    return summary
  }
  private ownedExtraImage(image: z.infer<typeof imagesSchema>[number]): boolean {
    const name = image.configuration.name.replace(/^docker\.io\/library\//, '')
    return (
      /^copse-worker:[a-zA-Z0-9_.-]+$/.test(name) &&
      name !== 'copse-worker:local' &&
      image.variants.length > 0 &&
      image.variants.every((variant) =>
        /^[a-f0-9]{64}$/.test(variant.config.config.Labels?.['dev.copse.worker-fingerprint'] ?? ''),
      )
    )
  }
  async clean(action: ContainerStorageAction, olderThan?: number): Promise<StorageCleanupResult> {
    if (!this.dependencies.supported) return { removed: 0, bytes: 0, skipped: 0 }
    const result = await this.dependencies.exclusive(async () => {
      const inventory = await this.inventory()
      // Apple's snapshot GC does not consider container references. Protect stopped containers too.
      if (inventory.busy)
        throw new Error(
          'Apple container storage is in use. Finish or remove other containers before cleanup.',
        )
      if (
        inventory.builder?.status.state === 'running' &&
        (await this.builderCache()).some((entry) => entry.inUse)
      )
        throw new Error('Apple builder cache is in use. Wait for builds to finish before cleanup.')
      const before = await allocated(this.dependencies.root)
      let removed = 0
      let skipped = 0
      switch (action) {
        case 'worker-images':
          for (const image of inventory.images) {
            if (!this.ownedExtraImage(image)) continue
            const created = Date.parse(image.configuration.creationDate)
            const lastUsed = Math.max(
              created,
              await this.dependencies.lastUsed(image.configuration.name),
            )
            if (!Number.isFinite(created) || (olderThan !== undefined && lastUsed >= olderThan)) {
              skipped++
              continue
            }
            await this.dependencies.run(['image', 'delete', image.configuration.name])
            removed++
          }
          break
        case 'apple-images':
          await this.dependencies.run(['image', 'prune'])
          removed = 1
          break
        case 'apple-builder':
          if (inventory.builder?.status.state !== 'running')
            throw new Error('The Apple builder must be running to clean its cache')
          await this.dependencies.run(['exec', 'buildkit', 'buildctl', 'prune'])
          removed = 1
          break
      }
      // Sparse VM files may retain allocated blocks after guest-side deletion.
      const after = await allocated(this.dependencies.root)
      return { removed, skipped, bytes: Math.max(0, before - after) }
    })
    return result ?? { removed: 0, bytes: 0, skipped: 1 }
  }
}

export function containerStorage(): ContainerStorage {
  return new ContainerStorage({
    supported: process.platform === 'darwin' && process.arch === 'arm64',
    root: join(homedir(), 'Library', 'Application Support', 'com.apple.container'),
    run: async (args) =>
      (await exec('container', args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout,
    lastUsed: appleImageLastUsed,
    exclusive: (run) =>
      appleContainerActivity().whenIdle(['runs'], () => withAppleBuilderLock(run)),
  })
}
