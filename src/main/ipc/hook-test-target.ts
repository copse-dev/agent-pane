import type { HookSummary, HookTestRequest } from '@shared/types/hooks.ts'

/**
 * Resolve a `hooks:test` request to the hook main-process discovery surfaced.
 *
 * The renderer only names a hook; it never supplies what gets spawned. The
 * returned request is rebuilt from the discovered {@link HookSummary}, so the
 * command, source/scope, and sandbox escape all come from discovery — a
 * renderer-sent `sandbox: false` is ignored. Main resolves process cwd from
 * that scope and the asking window's pinned project root.
 * Returns `undefined` when no discovered hook matches.
 */
export function resolveHookTestTarget(
  req: Omit<HookTestRequest, 'sandbox'>,
  discovered: readonly HookSummary[],
): HookTestRequest | undefined {
  const hook = discovered.find(
    (h) =>
      h.family === req.family &&
      h.event === req.event &&
      h.command === req.command &&
      h.source === req.source &&
      h.scope === req.scope,
  )
  if (!hook) return undefined
  return {
    family: hook.family,
    event: hook.event,
    command: hook.command,
    source: hook.source,
    scope: hook.scope,
    ...(hook.sandbox !== undefined ? { sandbox: hook.sandbox } : {}),
  }
}
