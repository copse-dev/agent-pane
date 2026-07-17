// Hook → Copse recursion guard (decision 5, `COPSE_HOOK_DEPTH`).
//
// A hook is arbitrary user/project shell. Nothing stops a hook script from
// invoking Copse again (`copse …`, an MCP tool that drives an agent, a wrapper
// that re-enters the app). That nested Copse would fire *its* hooks, whose
// scripts could re-enter again — an unbounded hook→Copse→hook loop that the
// auto-continuation budget (per turn tree) cannot see because each level is a
// separate process with its own turn trees.
//
// The guard is a depth counter carried in the environment: every spawned hook
// process gets `COPSE_HOOK_DEPTH` set to one more than the current process's
// depth ({@link childHookEnv}). A Copse instance that boots with the counter at
// or above {@link MAX_HOOK_DEPTH} is running *inside* a hook, so it suppresses
// its own command-hook dispatch ({@link hookRecursionGuardTripped}) — breaking
// the recursion at the first nested level while the top-level app (depth 0,
// env unset) fires hooks normally.
//
// Host-side (`src/main/services/hooks/`) — reads/writes process env, so it never
// belongs in the Electron-free `packages/agent` (execution-guidance rule 4).
import { envForRendererChildProcess } from '../exec/child-process-env.ts'

/** Env var carrying the hook nesting depth of the current Copse process. */
export const HOOK_DEPTH_ENV = 'COPSE_HOOK_DEPTH'

/**
 * Depth at which a Copse process stops firing command hooks. `1` means: the
 * top-level app (depth 0) fires hooks, but the moment we are running inside a
 * hook (depth ≥ 1) we fire none — a single nested level is enough to break the
 * recursion, and going deeper only re-enters the same loop.
 */
export const MAX_HOOK_DEPTH = 1

/** The current process's hook depth (0 when unset / unparseable). */
export function currentHookDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HOOK_DEPTH_ENV]
  if (raw === undefined) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Whether this process must suppress command-hook dispatch because it is already
 * running inside a hook (decision 5). Consulted at the command-hook spawn choke
 * point so a nested Copse never re-spawns hooks, closing the recursion loop.
 */
export function hookRecursionGuardTripped(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentHookDepth(env) >= MAX_HOOK_DEPTH
}

/**
 * Build the env a spawned hook process inherits: the secret-scrubbed renderer
 * child env ({@link envForRendererChildProcess}) plus `COPSE_HOOK_DEPTH` bumped
 * one level, so a Copse re-entered from the hook sees a higher depth and
 * suppresses its own hooks.
 */
export function childHookEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...envForRendererChildProcess(base),
    [HOOK_DEPTH_ENV]: String(currentHookDepth(base) + 1),
  }
}
