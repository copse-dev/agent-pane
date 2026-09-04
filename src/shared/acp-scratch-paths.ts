import { KNOWN_ACP_AGENTS, RETIRED_ACP_AGENTS } from './acp-known-agents.ts'

/**
 * Scratch directories external ACP agents hardcode, and the matching rules the
 * seatbelt and the shell-scope classifier share (issue #481, #590).
 *
 * POSIX-only by construction: `scratchPaths` exist because some agents ignore
 * the `$TMPDIR` redirect on macOS/Linux, and the seatbelt that needs them does
 * not run on Windows. Path handling therefore uses literal `/` rather than
 * `node:path`, so this module stays importable from the renderer and from the
 * eval harness without dragging in the sandbox's dependency graph.
 */

/** A scratch entry must be at least two segments deep (`/tmp/claude`, never `/tmp`). */
const MIN_SCRATCH_SEGMENTS = 2

/**
 * Expand a `scratchPaths` template to the concrete paths the seatbelt must
 * allow: `${uid}` becomes the numeric user id, and paths under the macOS
 * symlinked roots (`/tmp`, `/var`, `/etc` → `/private/...`) are emitted in
 * both spellings — the kernel enforces against the canonical path, while the
 * agent may write either.
 */
export function expandScratchPath(template: string): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const path = template.replace('${uid}', String(uid))
  // Settings validation keeps an entry absolute and `..`-free but says nothing
  // about depth, and these paths are allow-listed for writes — for every
  // contained command, not just the declaring agent's process. A one-segment
  // entry (`/`, `/tmp`, `/Users`) would hand back most of what the seatbelt
  // exists to withhold, so it expands to nothing rather than to a hole.
  if (path.split('/').filter(Boolean).length < MIN_SCRATCH_SEGMENTS) return []
  const paths = [path]
  const symlinkedRoot = /^\/(tmp|var|etc)(\/|$)/.exec(path)
  if (symlinkedRoot) paths.push(`/private${path}`)
  return paths
}

/**
 * Whether an absolute path falls under one expanded scratch entry.
 *
 * A literal entry matches itself and its subtree. A glob entry (`/tmp/claude-*`,
 * which the seatbelt uses to cover Claude Code's sibling `-cwd` bookkeeping
 * files) matches by the prefix before the star — the same single-segment reach
 * ASRT gives it. Globs shallower than {@link MIN_SCRATCH_SEGMENTS} match nothing,
 * so a malformed `/*` in user settings cannot waive the whole filesystem.
 */
export function matchesScratchEntry(entry: string, absPath: string): boolean {
  const star = entry.indexOf('*')
  if (star === -1) return absPath === entry || absPath.startsWith(`${entry}/`)
  const prefix = entry.slice(0, star)
  if (prefix.split('/').filter(Boolean).length < MIN_SCRATCH_SEGMENTS) return false
  return absPath.startsWith(prefix)
}

/**
 * Scratch entries declared by the offered agent catalog, expanded.
 *
 * The pure half of the resolver: no settings read, so the eval harness can score
 * against the same roots the product allows without importing the seatbelt.
 * Copse's main process uses the settings-aware
 * `sanctionedAgentScratchEntries()` instead, which honours per-agent overrides.
 */
export function catalogScratchEntries(): string[] {
  // Retired entries count too, for the reason `findAcpCatalogEntry` spans them:
  // a config written before an agent was withdrawn still names it, and it still
  // spawns under that preset's confines.
  const entries = [...KNOWN_ACP_AGENTS, ...RETIRED_ACP_AGENTS].flatMap(
    (agent) => agent.sandbox?.scratchPaths ?? [],
  )
  return [...new Set(entries.flatMap(expandScratchPath))]
}
