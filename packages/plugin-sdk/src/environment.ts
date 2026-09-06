import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'

/**
 * The one host fact the SDK's host-side helpers need: the profile root under
 * which reviewed plugin runtime snapshots are stored
 * (`<root>/plugin-tool-snapshots`, overridable per process with
 * `COPSE_PLUGIN_TOOL_SNAPSHOT_DIR`). Defaults to `COPSE_DIR` or `~/.copse`; the
 * Copse app binds its `copseDataRoot` resolver once in
 * `src/main/services/plugins/plugin-sdk-environment.ts`.
 */
export interface PluginSdkEnvironment {
  dataRoot: () => string
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return copseDataRoot(env)
}

const DEFAULTS: PluginSdkEnvironment = { dataRoot: () => defaultDataRoot() }

let environment: PluginSdkEnvironment = DEFAULTS

/** Install the host environment. Passing nothing restores the defaults. */
export function configurePluginSdk(next: Partial<PluginSdkEnvironment> = {}): void {
  environment = { ...DEFAULTS, ...next }
}

export function pluginSdkEnvironment(): PluginSdkEnvironment {
  return environment
}
