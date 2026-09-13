import type {
  AppRunAction,
  AppRunApp,
  AppRunDevice,
  AppRunIssue,
  AppRunSelection,
  AppRunSetupInput,
  AppRunSetupOptions,
  AppRunStage,
} from '@shared/types/app-run.ts'

export interface AppRunProgress {
  stage: (stage: AppRunStage) => void
  log: (text: string) => void
}
export interface AppRunDriverDiscovery {
  apps: AppRunApp[]
  devices: AppRunDevice[]
  issues: AppRunIssue[]
}
export interface AppRunDriverResult {
  desktopId?: string
  appSessionId?: string
}
export interface AppRunDriver {
  detect(root: string): Promise<boolean>
  discover(root: string, signal: AbortSignal): Promise<AppRunDriverDiscovery>
  devices(
    root: string,
    app: AppRunApp,
    signal: AbortSignal,
    variant?: string,
  ): Promise<AppRunDevice[]>
  execute(
    root: string,
    app: AppRunApp,
    selection: AppRunSelection,
    action: AppRunAction,
    operationId: string,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<AppRunDriverResult>
  stop(root: string, sessionId: string, signal: AbortSignal): Promise<void>
  setupOptions(root: string, signal: AbortSignal): Promise<AppRunSetupOptions>
  setup(
    root: string,
    input: AppRunSetupInput,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<void>
}
