import { z } from 'zod'

export const appRunPlatformSchema = z.enum(['apple', 'android'])
export type AppRunPlatform = z.infer<typeof appRunPlatformSchema>
export const appRunOwnerSchema = z.object({
  projectId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256).optional(),
})
export type AppRunOwner = z.infer<typeof appRunOwnerSchema>
export const appRunSelectionSchema = z.object({
  appId: z.string().min(1).max(2048),
  deviceId: z.string().max(512),
  variant: z.string().min(1).max(256),
  configuration: z.string().min(1).max(128).default('Debug'),
  provisioningUpdates: z.boolean().default(false),
})
export type AppRunSelection = z.infer<typeof appRunSelectionSchema>
export interface AppRunApp {
  id: string
  platform: AppRunPlatform
  name: string
  location: string
  variants: string[]
}
export interface AppRunDevice {
  id: string
  platform: AppRunPlatform
  name: string
  runtime: string
  state: 'running' | 'stopped' | 'unavailable'
  detail?: string
}
export const appRunSetupKindSchema = z.enum([
  'open-xcode',
  'open-android-studio',
  'install-ios-runtime',
  'install-android-image',
  'create-device',
])
export type AppRunSetupKind = z.infer<typeof appRunSetupKindSchema>
export interface AppRunIssue {
  platform: AppRunPlatform
  message: string
  action: AppRunSetupKind
  label: string
}
export interface AppRunDiscovery {
  apps: AppRunApp[]
  devices: AppRunDevice[]
  issues: AppRunIssue[]
  preferred: AppRunSelection | null
}
export const appRunStageSchema = z.enum([
  'queued',
  'building',
  'starting-device',
  'testing',
  'installing',
  'launching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stopped',
  'setting-up',
])
export type AppRunStage = z.infer<typeof appRunStageSchema>
export const appRunActionSchema = z.enum(['run', 'build', 'test'])
export type AppRunAction = z.infer<typeof appRunActionSchema>
export const appRunOperationSchema = z.object({
  id: z.string(),
  owner: appRunOwnerSchema,
  action: z.enum(['run', 'build', 'test', 'setup']),
  stage: appRunStageSchema,
  appName: z.string(),
  deviceName: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  logs: z.string(),
  error: z.string().nullable(),
  desktopId: z.string().nullable(),
  appSessionId: z.string().nullable(),
})
export type AppRunOperation = z.infer<typeof appRunOperationSchema>
export interface AppRunSetupOptions {
  runtimes: { id: string; name: string; installed: boolean }[]
  deviceTypes: { id: string; name: string }[]
}
export const appRunSetupInputSchema = z.object({
  platform: appRunPlatformSchema,
  action: appRunSetupKindSchema,
  runtimeId: z.string().max(512).optional(),
  deviceTypeId: z.string().max(512).optional(),
  name: z.string().trim().min(1).max(80).optional(),
})
export type AppRunSetupInput = z.infer<typeof appRunSetupInputSchema>
export const APP_RUN_STAGE_LABELS: Record<AppRunStage, string> = {
  queued: 'Queued',
  building: 'Building',
  'starting-device': 'Starting device',
  testing: 'Testing',
  installing: 'Installing',
  launching: 'Launching',
  running: 'App running',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  stopped: 'App stopped',
  'setting-up': 'Setting up',
}
