import {
  analyzeShellCommand,
  dangerousInSandboxReasons,
  normalizeShellCommandForAnalysis,
} from './shell-scope.ts'

/**
 * Command routing — decide *which sandbox context* a shell command runs in.
 *
 * This layer sits on top of {@link analyzeShellCommand} (the network/outside-path
 * heuristic) and turns its binary sandbox/external verdict into a richer set of
 * execution tiers, so an approved command can run in the *minimal* context that
 * actually satisfies it instead of the coarse "contained-or-prompt" split:
 *
 * - `read`      — sandbox-confined, filesystem **read-only**, no network.
 * - `write`     — sandbox-confined, workspace read+write, no network (today's
 *                 default contained overlay).
 * - `container` — stronger host isolation (a VM/container). No cross-platform
 *                 backend ships yet, so the tier is modelled here and the wiring
 *                 layer maps it to the strongest available sandbox (or a prompt).
 * - `allow`     — run **unsandboxed with no prompt**. The user's explicit trust
 *                 grant for a narrow set of commands that cannot be sandboxed but
 *                 are safe (e.g. `xcodebuild`, which needs the host toolchain,
 *                 code-signing, and Apple endpoints). This is the prompt-fatigue
 *                 lever: an allow-listed command never interrupts the user.
 * - `prompt`    — not resolvable to a safe auto-run context; ask the user (the
 *                 existing behaviour for unknown/external/destructive commands).
 *
 * This module is PURE and has no side effects — it mirrors `shell-scope.ts` so it
 * can be unit-tested exhaustively and wired into the permission gate separately.
 * It is a UX/routing refinement, **not** a new security boundary: the OS sandbox
 * (macOS seatbelt) remains the real containment, and the destructive-pattern and
 * command-substitution guards below are never bypassed — not even for an
 * allow-listed command.
 */

/** Isolation/permission tier a command (or one of its segments) is routed to. */
export type CommandTier = 'read' | 'write' | 'container' | 'allow' | 'prompt'

/** A single routing rule: a command *head* (basename) mapped to a tier. */
export interface CommandRoute {
  /** Command basename this rule matches, e.g. `xcodebuild` or `mkdir`. */
  command: string
  tier: Exclude<CommandTier, 'prompt'>
}

export interface SegmentRouting {
  /** The raw segment text (a top-level `&&`/`||`/`;`/`|`-delimited slice). */
  segment: string
  /** The resolved command head, or null when none could be extracted. */
  head: string | null
  tier: CommandTier
  /** Why this tier was chosen (for the approval dialog / observability). */
  reasons: string[]
}

export type CommandRouting =
  | { outcome: 'run'; tier: Exclude<CommandTier, 'prompt'>; segments: SegmentRouting[]; reasons: string[] }
  | { outcome: 'prompt'; segments: SegmentRouting[]; reasons: string[] }

/**
 * Built-in routing defaults. These only ever *refine within the safe space* a
 * command already occupies — a table hit cannot promote a command past the
 * whole-command destructive/substitution gates, and the network/outside-path
 * heuristic still applies to every tier except `allow`.
 *
 * The `allow` tier ships EMPTY on purpose: running a binary unsandboxed with no
 * prompt is a real per-project trust decision, so users opt in (e.g. add
 * `xcodebuild` for an iOS project). The seeded entries are limited to commands
 * whose safety does not depend on their subcommand or flags — so `git` is absent
 * (its network subcommands are the analyzer's job), and `cp`/`mv` route to
 * `write` while the outside-path guard still forces a prompt when their arguments
 * escape the workspace.
 */
export const DEFAULT_COMMAND_ROUTES: readonly CommandRoute[] = [
  // Pure inspectors — no writes, no network.
  { command: 'ls', tier: 'read' },
  { command: 'pwd', tier: 'read' },
  { command: 'echo', tier: 'read' },
  { command: 'cat', tier: 'read' },
  { command: 'head', tier: 'read' },
  { command: 'tail', tier: 'read' },
  { command: 'wc', tier: 'read' },
  { command: 'which', tier: 'read' },
  { command: 'basename', tier: 'read' },
  { command: 'dirname', tier: 'read' },
  { command: 'date', tier: 'read' },
  { command: 'true', tier: 'read' },
  { command: 'false', tier: 'read' },
  // Workspace mutators — writes stay inside the seatbelt; the outside-path guard
  // still promotes an escaping argument to a prompt.
  { command: 'mkdir', tier: 'write' },
  { command: 'touch', tier: 'write' },
  { command: 'cp', tier: 'write' },
  { command: 'mv', tier: 'write' },
  { command: 'tee', tier: 'write' },
]

/** Merge user-defined routes over the built-in defaults (user wins per command). */
export function buildRoutingTable(userRoutes: readonly CommandRoute[] = []): Map<string, CommandTier> {
  const table = new Map<string, CommandTier>()
  for (const { command, tier } of DEFAULT_COMMAND_ROUTES) table.set(command, tier)
  for (const { command, tier } of userRoutes) table.set(command, tier)
  return table
}

// Leading tokens that wrap the *real* command without changing what runs: env
// assignments (`FOO=bar cmd`) and a few transparent launchers. `sudo`/`su` are
// intentionally absent — they are privilege escalation and already force a prompt
// via the destructive-pattern guard, so we never want to see past them.
const TRANSPARENT_PREFIXES = new Set(['env', 'command', 'exec', 'nohup', 'nice', 'time', 'builtin'])

/**
 * Extract the command head (basename) from a segment for table lookup:
 * strips leading subshell/grouping punctuation, `VAR=val` assignments, and
 * transparent wrappers, then reduces a path to its basename (`/usr/bin/xcodebuild`
 * → `xcodebuild`). Returns null when no command token can be found.
 */
export function commandHead(segment: string): string | null {
  let text = normalizeShellCommandForAnalysis(segment).trim()
  // Drop leading grouping/redirection punctuation a segment can open with.
  text = text.replace(/^[({\s]+/, '')
  const tokens = text.split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (/^\w+=/.test(token)) continue // environment assignment
    const base = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
    if (TRANSPARENT_PREFIXES.has(base)) continue
    return base || null
  }
  return null
}

// Split a command line into top-level segments at shell control operators
// (`&&`, `||`, `;`, `|`, `&`, newline), respecting single/double quotes so an
// operator inside a string literal (`echo "a && b"`) does not split. Command
// substitution is handled separately (it forces a prompt), so we do not descend
// into `$(...)`/backticks here.
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\n' || ch === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if ((ch === '&' || ch === '|') && next === ch) {
      segments.push(current)
      current = ''
      i++ // consume the doubled operator
      continue
    }
    if (ch === '|' || ch === '&') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map((s) => s.trim()).filter(Boolean)
}

/** Command substitution can hide arbitrary tools; it always forces a prompt. */
function hasCommandSubstitution(command: string): boolean {
  return /\$\(|`/.test(command)
}

/**
 * Resolve one segment to a tier. `allow`-listed heads waive the network/outside-
 * path heuristic for *that* segment (the whole point of the trust grant), but the
 * whole-command destructive and substitution gates in {@link resolveCommandRouting}
 * are applied first and are never reached here as `allow`.
 */
function resolveSegmentTier(
  segment: string,
  workspaceRoot: string | null,
  table: Map<string, CommandTier>,
): SegmentRouting {
  const head = commandHead(segment)
  const routed = head ? table.get(head) : undefined

  if (routed === 'allow') {
    return { segment, head, tier: 'allow', reasons: [`\`${head}\` is on the complete-allow list`] }
  }

  const analysis = analyzeShellCommand(segment, workspaceRoot)
  if (analysis.verdict === 'external') {
    return { segment, head, tier: 'prompt', reasons: analysis.reasons }
  }

  if (routed) {
    return { segment, head, tier: routed, reasons: [`\`${head ?? '?'}\` routes to ${routed}`] }
  }

  // No table entry and not external → sandbox-contained. Both `sandbox` and
  // `ambiguous` auto-run inside the seatbelt today, so both map to `write`.
  return {
    segment,
    head,
    tier: 'write',
    reasons: analysis.verdict === 'ambiguous' ? analysis.reasons : ['contained: no escape signals'],
  }
}

/**
 * Join the per-segment tiers into the single execution context that satisfies
 * every segment, or `prompt` when no safe context does:
 *
 * - any `prompt` segment → `prompt` (never silently escalate an unknown command);
 * - `allow` + `container` are incompatible (a command cannot be both unsandboxed
 *   and containerized) → `prompt`;
 * - otherwise the most-permissive required context wins:
 *   `allow` > `container` > `write` > `read`.
 */
export function joinTiers(tiers: readonly CommandTier[]): CommandTier {
  if (tiers.includes('prompt')) return 'prompt'
  const hasAllow = tiers.includes('allow')
  const hasContainer = tiers.includes('container')
  if (hasAllow && hasContainer) return 'prompt'
  if (hasAllow) return 'allow'
  if (hasContainer) return 'container'
  if (tiers.includes('write')) return 'write'
  return 'read'
}

/**
 * Route a (possibly compound) shell command to its execution context.
 *
 * Whole-command gates run first and are never bypassed — they catch cross-segment
 * tricks that per-segment analysis would miss (e.g. `cat local | sh` pipes a file
 * into an interpreter across a segment boundary). Only once those pass do we split
 * and classify each segment to pick the minimal shared context.
 */
export function resolveCommandRouting(
  command: string,
  workspaceRoot: string | null,
  table: Map<string, CommandTier>,
): CommandRouting {
  const trimmed = command.trim()
  if (!trimmed) {
    return { outcome: 'run', tier: 'read', segments: [], reasons: ['empty command'] }
  }

  if (hasCommandSubstitution(trimmed)) {
    return {
      outcome: 'prompt',
      segments: [],
      reasons: ['command substitution (may hide network or outside-path tools)'],
    }
  }
  const dangerous = dangerousInSandboxReasons(trimmed)
  if (dangerous.length > 0) {
    return { outcome: 'prompt', segments: [], reasons: dangerous }
  }

  const segments = splitSegments(trimmed).map((s) => resolveSegmentTier(s, workspaceRoot, table))
  const tier = joinTiers(segments.map((s) => s.tier))

  if (tier === 'prompt') {
    const reasons = segments.filter((s) => s.tier === 'prompt').flatMap((s) => s.reasons)
    const incompatible = reasons.length === 0 ? ['incompatible sandbox contexts across segments'] : reasons
    return { outcome: 'prompt', segments, reasons: incompatible }
  }

  return {
    outcome: 'run',
    tier,
    segments,
    reasons: [`runs in ${tier} context`, ...segments.flatMap((s) => s.reasons)],
  }
}
