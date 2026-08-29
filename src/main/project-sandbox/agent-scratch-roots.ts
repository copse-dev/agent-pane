import { matchesScratchEntry, expandScratchPath } from '@shared/acp-scratch-paths.ts'
import { listEnabledAcpAgents, resolveAcpSandbox } from '../services/acp/acp-agent-registry.ts'

/**
 * Scratch directories the host treats as sanctioned because a configured ACP
 * agent declares them (issue #481).
 *
 * The problem these solve: Claude Code sets `TMPDIR=/tmp/claude` for its own
 * shell, overriding the workspace-owned `$TMPDIR` Copse hands the agent process
 * (`acp-client.ts`). Every scratch file the agent writes — following Copse's own
 * "put scratch in $TMPDIR" steer — therefore lands in system temp, which the
 * seatbelt denies writes to and `shell-scope.ts` classifies as an outside path.
 * The agent obeys the instruction and still gets a "Run outside sandbox?"
 * dialog, which no amount of prompt steering can fix because the environment,
 * not the model, is what disagrees.
 *
 * Resolution is **host-level, not per-session**: these roots are sanctioned for
 * every command Copse classifies, not only for turns driven by the agent that
 * declared them. Threading agent identity into `analyzeShellCommand` would mean
 * an extra parameter on eight call sites across four modules, and the precision
 * it buys is thin — the entries are fixed, tool-owned bookkeeping directories,
 * not general-purpose locations. The cost of getting it wrong in the other
 * direction is worse: the classifier and the seatbelt must agree, or a command
 * stops prompting and then fails EPERM instead.
 *
 * The user's off switch is the existing per-agent config, no new setting: clear
 * `sandbox.scratchPaths`, set `sandbox: false`, or disable the agent — each
 * drops its entries here (`resolveAcpSandbox` read-throughs to the catalog
 * preset only while the config asks for it).
 */
export function sanctionedAgentScratchEntries(): string[] {
  const declared = listEnabledAcpAgents().flatMap(
    (agent) => resolveAcpSandbox(agent)?.scratchPaths ?? [],
  )
  return [...new Set(declared.flatMap(expandScratchPath))]
}

/**
 * A predicate over absolute paths, or `null` when no agent declares scratch
 * directories — the common case for a Copse-native session, which then skips the
 * scan entirely.
 *
 * Returning a closure rather than a per-path predicate is deliberate: resolution
 * reads settings, and the classifier asks about every absolute token in a command
 * (`analyzeShellCommand` itself runs several times per approval). One read per
 * scan instead of one per token keeps `electron-store`'s whole-file parse off a
 * path that runs on every command.
 */
export function agentScratchMatcher(): ((absPath: string) => boolean) | null {
  const entries = sanctionedAgentScratchEntries()
  if (entries.length === 0) return null
  return (absPath: string): boolean => entries.some((entry) => matchesScratchEntry(entry, absPath))
}
