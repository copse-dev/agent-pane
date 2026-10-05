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
}
