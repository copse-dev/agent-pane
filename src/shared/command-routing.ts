/**
 * Shared command-routing types and the plain-text serialization used by the
 * Settings UI. Kept free of Node built-ins so it can be imported from the
 * renderer (the resolution logic in
 * `src/main/services/security/command-routing.ts` depends on `shell-scope.ts`
 * and stays main-process-only).
 */

/** Isolation/permission tier a command (or one of its segments) is routed to. */
export type CommandTier = 'read' | 'write' | 'container' | 'allow' | 'prompt'

/** A tier a user may assign in the routing table (`prompt` is a resolution outcome, not assignable). */
export type AssignableTier = Exclude<CommandTier, 'prompt'>

/** A single routing rule: a command *head* (basename) mapped to a tier. */
export interface CommandRoute {
  /** Command basename this rule matches, e.g. `xcodebuild` or `mkdir`. */
  command: string
  tier: AssignableTier
}

/** Persisted per-project routing table (array of `{ command, tier }`). */
export const COMMAND_ROUTES_SETTING = 'commandRoutingTable'

export const ASSIGNABLE_TIERS: readonly AssignableTier[] = ['read', 'write', 'container', 'allow']

function isAssignableTier(value: string): value is AssignableTier {
  return (ASSIGNABLE_TIERS as readonly string[]).includes(value)
}

/**
 * Parse the Settings textarea (`command:tier` per line) into routes. Tolerant by
 * design: blank lines and `#` comments are skipped, malformed lines and unknown
 * tiers are dropped, and the first rule for a command wins on duplicates.
 */
export function parseCommandRoutes(text: string): CommandRoute[] {
  const routes: CommandRoute[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.lastIndexOf(':')
    if (idx <= 0) continue
    const command = line.slice(0, idx).trim()
    const tier = line.slice(idx + 1).trim()
    if (!command || seen.has(command) || !isAssignableTier(tier)) continue
    seen.add(command)
    routes.push({ command, tier })
  }
  return routes
}

/** Serialize routes back to the `command:tier` textarea format. */
export function formatCommandRoutes(routes: readonly CommandRoute[]): string {
  return routes.map((r) => `${r.command}:${r.tier}`).join('\n')
}

/** Validate a route array coming off the settings store (drops malformed entries). */
export function sanitizeCommandRoutes(value: unknown): CommandRoute[] {
  if (!Array.isArray(value)) return []
  const routes: CommandRoute[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const command = (entry as { command?: unknown }).command
    const tier = (entry as { tier?: unknown }).tier
    if (typeof command !== 'string' || typeof tier !== 'string') continue
    const trimmed = command.trim()
    if (!trimmed || seen.has(trimmed) || !isAssignableTier(tier)) continue
    seen.add(trimmed)
    routes.push({ command: trimmed, tier })
  }
  return routes
}
