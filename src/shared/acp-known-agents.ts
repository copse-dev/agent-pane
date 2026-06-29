/**
 * Catalog of well-known external ACP agents Copse can drive (client role). Used
 * to (a) detect what's already installed/running on the device and (b) prefill a
 * `registeredAcpAgents` entry so the user doesn't have to hand-write one.
 *
 * This is a convenience shortlist, not an allowlist — any ACP-speaking command
 * can be configured manually. Keep entries conservative: only ship `command` /
 * `args` we're confident launch the agent in ACP (stdio) mode. Extend freely.
 *
 * Pure data with no imports so the standalone detect script (plain node, no
 * bundler/alias) and the app can both consume it.
 */
export interface KnownAcpAgent {
  /** Slug used as the configured agent id and the `acp:<id>` model value. */
  id: string
  /** Human-readable name for the picker / detector output. */
  title: string
  /** Executable that speaks ACP over stdio (looked up on PATH). */
  command: string
  /** Arguments that put the command into ACP mode. */
  args: string[]
  /** Environment variables the agent typically needs (names only; values are the user's). */
  envHints?: string[]
  /** Short note shown by the detector (auth, caveats). */
  note?: string
}

/** A {@link KnownAcpAgent} annotated with what was found on the device. */
export interface DetectedAcpAgent extends KnownAcpAgent {
  /** The command resolves on PATH. */
  installed: boolean
  /** Absolute path the command resolves to, when installed. */
  path: string | null
  /** A process whose argv[0] is this command is currently running. */
  running: boolean
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    envHints: ['GEMINI_API_KEY'],
    note: 'Google Gemini CLI. Needs GEMINI_API_KEY or its own `gemini` login.',
  },
  {
    id: 'claude-code-acp',
    title: 'Claude Code (ACP)',
    command: 'claude-code-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    note: "Zed's Claude Code ACP adapter (npm @zed-industries/claude-code-acp).",
  },
]
