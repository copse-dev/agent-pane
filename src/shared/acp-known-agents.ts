/**
 * Catalog of well-known external ACP agents Copse can drive (client role). Used
 * to (a) detect what's already installed/running on the device, (b) prefill a
 * `registeredAcpAgents` entry, and (c) show "preinstall" guidance — how to
 * install the agent binary and how to authenticate it.
 *
 * Important: the agent is a *separate program*, not bundled with Copse. Copse
 * ships only `@agentclientprotocol/sdk` (the client/protocol half); the agent
 * half (which wraps Claude/Gemini/etc. and speaks ACP over stdio) is installed
 * by the user via `install` below. Keep entries conservative: only ship
 * `command`/`args` we're confident launch the agent in ACP mode. Extend freely.
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
  /** Shell command that installs the agent binary (e.g. an `npm install -g …`). */
  install?: string
  /** Shell command that authenticates the agent / mints a token (e.g. `claude setup-token`). */
  setup?: string
  /** Where to read more about the agent. */
  docsUrl?: string
  /** Short note shown by the detector (auth, caveats). */
  note?: string
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    envHints: ['GEMINI_API_KEY'],
    install: 'npm install -g @google/gemini-cli',
    setup: 'gemini', // first run walks through Google sign-in; or set GEMINI_API_KEY
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    note: 'Sign in by running `gemini` once, or set GEMINI_API_KEY.',
  },
  {
    id: 'claude-agent-acp',
    title: 'Claude Agent (ACP)',
    command: 'claude-agent-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    setup: 'claude setup-token',
    docsUrl: 'https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp',
    note: 'Claude Agent SDK over ACP. Auth with `claude setup-token` or ANTHROPIC_API_KEY.',
  },
  {
    id: 'claude-code-acp',
    title: 'Claude Code (ACP, Zed)',
    command: 'claude-code-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @zed-industries/claude-code-acp',
    setup: 'claude setup-token',
    docsUrl: 'https://www.npmjs.com/package/@zed-industries/claude-code-acp',
    note: "Zed's Claude Code ACP adapter. Auth with `claude setup-token` or ANTHROPIC_API_KEY.",
  },
]

/** A {@link KnownAcpAgent} annotated with what was found on the device. */
export interface DetectedAcpAgent extends KnownAcpAgent {
  /** The command resolves on PATH. */
  installed: boolean
  /** Absolute path the command resolves to, when installed. */
  path: string | null
  /** A process whose argv[0] is this command is currently running. */
  running: boolean
}
