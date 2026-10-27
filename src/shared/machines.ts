import { z } from 'zod'

export const REMOTE_SYSTEM_ONE_MODELS_SETTING = 'remoteSystemOneModelsEnabled'

export const machineAddressSchema = z
  .ipv4()
  .refine((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.0\.0\.1$)/.test(ip))
export const machineEndpointSchema = z.strictObject({
  address: machineAddressSchema,
  port: z.number().int().min(1).max(65535),
  fingerprint: z.string().regex(/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/),
})
export const sharedModelSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,53}$/),
  label: z.string().min(1).max(128),
  model: z.string().min(1).max(512),
  timeoutMs: z.number().int().min(100).max(600_000),
})
export type SharedMachineModel = z.infer<typeof sharedModelSchema>
export const machineSharingSchema = z.strictObject({
  enabled: z.boolean(),
  address: machineAddressSchema,
  port: z.number().int().min(0).max(65535),
  profileIds: z.array(sharedModelSchema.shape.id).max(64),
})
export type MachineSharing = z.infer<typeof machineSharingSchema>
export interface PairedMachine {
  id: string
  name: string
  address: string
  status: 'connected' | 'reconnecting' | 'unavailable'
  detail: string
  models: SharedMachineModel[]
}
export interface MachinesState {
  featureEnabled: boolean
  machines: PairedMachine[]
  addresses: Array<{ address: string; label: string }>
  sharing: MachineSharing & { listening: boolean; error: string | null }
  shareableModels: SharedMachineModel[]
  clients: Array<{ id: string; name: string }>
  secureStorage: boolean
}
export interface MachinesClient {
  state(): Promise<MachinesState>
  pair(code: string): Promise<MachinesState>
  remove(id: string): Promise<MachinesState>
  share(config: MachineSharing): Promise<MachinesState>
  invitation(): Promise<string>
  revoke(id: string): Promise<MachinesState>
}
