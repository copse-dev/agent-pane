import type { HookSandboxRuntime } from './hook-spawn.ts'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'

/**
 * Facts the dialect adapters and the hook runner cannot know on their own and
 * the host supplies once. Every default is the conservative reading for a
 * standalone consumer; the Copse app binds its real implementations in
 * `src/main/services/hooks/hooks-dialects-environment.ts`, imported for its
 * side effect by every app-side re-export of a package module.
 *
 * - `sandbox`: the OS sandbox hooks spawn inside by default (F3, decision 7).
 *   The default reports no sandbox, so hooks spawn unsandboxed exactly as they
 *   do on Linux and Windows today — a default, not a guarantee, per the plan.
 * - `childEnv`: the environment handed to an unsandboxed hook process. The
 *   default drops nothing but undefined values; the app binds its secret
 *   scrubber so LLM tokens never reach a hook.
 * - `agentExecutionRoot`: the current agent turn's execution root (worktree or
 *   project), used as the cwd a hook is told about. Default: unknown.
 * - `dataRoot`: where the user-level Copse hooks file lives (`<root>/hooks.json`).
 *   Defaults to `COPSE_DIR` or `~/.copse`.
 */
export interface HooksDialectsEnvironment {
  sandbox: HookSandboxRuntime
  childEnv: (base?: NodeJS.ProcessEnv) => Record<string, string>
  agentExecutionRoot: () => string | null
  dataRoot: () => string
}

const NO_SANDBOX: HookSandboxRuntime = {
  enabled: () => false,
  spawnShell: () => Promise.reject(new Error('no hook sandbox runtime is configured')),
  violationCount: () => 0,
  afterCommand: () => {},
}

export function passthroughChildEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return copseDataRoot(env)
}

const DEFAULTS: HooksDialectsEnvironment = {
  sandbox: NO_SANDBOX,
  childEnv: passthroughChildEnv,
  agentExecutionRoot: () => null,
  dataRoot: () => defaultDataRoot(),
}

let environment: HooksDialectsEnvironment = DEFAULTS

/** Install the host environment. Passing nothing restores the defaults. */
export function configureHooksDialects(next: Partial<HooksDialectsEnvironment> = {}): void {
  environment = { ...DEFAULTS, ...next }
}

export function hooksDialectsEnvironment(): HooksDialectsEnvironment {
  return environment
}
