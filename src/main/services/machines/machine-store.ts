import { z } from 'zod'
import { machineEndpointSchema, machineSharingSchema, sharedModelSchema } from '@shared/machines.ts'

const encrypted = z.string().min(1).max(32_768)
export const machineStoreSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  identity: z.strictObject({ certificate: z.string().max(16_384), key: encrypted }).nullable(),
  sharing: machineSharingSchema,
  machines: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().min(1).max(128),
        endpoint: machineEndpointSchema,
        token: encrypted,
        models: z.array(sharedModelSchema).max(64),
      }),
    )
    .max(32),
  clients: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().min(1).max(128),
        token: encrypted,
      }),
    )
    .max(32),
})
export type MachineStoreData = z.infer<typeof machineStoreSchema>
export interface MachineStore {
  enabled(): boolean
  load(): MachineStoreData | null
  save(value: MachineStoreData): Promise<void>
  seal(value: string): string
  open(value: string): string
  available(): boolean
}
