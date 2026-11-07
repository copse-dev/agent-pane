import { z } from 'zod'

export const storageAreaSchema = z.enum(['runs', 'builds'])
export type StorageArea = z.infer<typeof storageAreaSchema>
export const storageRetentionSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1).max(365),
})
export type StorageRetention = z.infer<typeof storageRetentionSchema>
export interface StorageCleanupSummary {
  area: StorageArea
  bytes: number
  entries: number
  busy: boolean
}
export interface StorageCleanupResult {
  removed: number
  bytes: number
  skipped: number
}
export interface StorageMaintenanceState {
  retention: StorageRetention
  areas: StorageCleanupSummary[]
  containers: ContainerStorageSummary
}

export const CONTAINER_STORAGE_ACTIONS = ['worker-images', 'apple-images', 'apple-builder'] as const
export const containerStorageActionSchema = z.enum(CONTAINER_STORAGE_ACTIONS)
export type ContainerStorageAction = z.infer<typeof containerStorageActionSchema>
export interface ContainerStorageImage {
  name: string
  bytes: number
  snapshotBytes: number
  eligible: boolean
}
export interface ContainerStorageSummary {
  available: boolean
  error: string | null
  busy: boolean
  totalBytes: number
  snapshotsBytes: number
  blobsBytes: number
  containersBytes: number
  volumesBytes: number
  otherBytes: number
  snapshotCount: number
  unmatchedSnapshots: number
  images: ContainerStorageImage[]
  builderRunning: boolean
  builderDiskBytes: number
  builderCacheBytes: number | null
  builderReclaimableBytes: number | null
}

export function emptyContainerStorage(error: string | null = null): ContainerStorageSummary {
  return {
    available: false,
    error,
    busy: false,
    totalBytes: 0,
    snapshotsBytes: 0,
    blobsBytes: 0,
    containersBytes: 0,
    volumesBytes: 0,
    otherBytes: 0,
    snapshotCount: 0,
    unmatchedSnapshots: 0,
    images: [],
    builderRunning: false,
    builderDiskBytes: 0,
    builderCacheBytes: null,
    builderReclaimableBytes: null,
  }
}
