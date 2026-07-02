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
  /**
   * npm package spec to install for auto-setup (Socket-Firewall-wrapped). Present
   * only for agents distributed on npm; absent for script-installed binaries such
   * as `cursor-agent` (which auto-setup will never install — see {@link autoInstall}).
   */
  installPackage?: string
  /**
   * Parent client whose presence gates this agent in auto-setup. For the Claude
   * adapter it's `claude` (installing the ACP SDK only makes sense when the user
   * has Claude); for Cursor it's the `cursor-agent` binary itself. Absent = no gate.
   */
  requiresClient?: string
  /**
   * Whether auto-setup may install {@link installPackage} for the user (through
   * Socket Firewall) when {@link requiresClient} is present but the agent isn't.
   * Only true for npm-distributed agents; never for `curl | bash` installers.
   */
  autoInstall?: boolean
  /**
   * Whether auto-setup should register this agent as a ready-to-use preset once
   * its binary is available. Curated to one adapter per client (Claude, Cursor)
   * so auto-setup doesn't register several near-duplicate entries.
   */
  preset?: boolean
  /**
   * Seatbelt confinement preset (issue #590): domains the agent's process may
   * reach and the home-relative dirs it needs for its own config/state. Copied
   * onto the registered `AcpAgentConfig`; agents without a preset spawn
   * unsandboxed. Keep domains minimal — the user can widen them per agent.
   */
  sandbox?: { allowedDomains: string[]; homeDirs?: string[]; scratchPaths?: string[] }
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
    sandbox: {
      // Google API infra wholesale (model + OAuth endpoints move between
      // *.googleapis.com subdomains) plus the account login host.
      allowedDomains: ['*.googleapis.com', 'accounts.google.com'],
      homeDirs: ['.gemini', '.config/gemini'],
    },
    setup: 'gemini', // first run walks through Google sign-in; or set GEMINI_API_KEY
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    note: 'Sign in by running `gemini` once, or set GEMINI_API_KEY.',
  },
  {
    id: 'claude-agent-acp',
    title: 'Claude',
    command: 'claude-agent-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    installPackage: '@agentclientprotocol/claude-agent-acp',
    requiresClient: 'claude',
    autoInstall: true,
    preset: true,
    sandbox: {
      // Anthropic-owned infra wholesale: the API lives on api.anthropic.com,
      // but OAuth token refresh (console.anthropic.com / claude.ai) and
      // telemetry move between subdomains — pinning individual hosts breaks
      // auth ("403 Connection blocked by network allowlist") when they do.
      allowedDomains: ['anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai'],
      homeDirs: ['.claude', '.claude.json', '.claude.json.backup', '.config/claude'],
      // Claude Code hardcodes shell/task bookkeeping under /tmp/claude-<uid>,
      // ignoring $TMPDIR — without this every Bash call fails at mkdir.
      scratchPaths: ['/tmp/claude-${uid}'],
    },
    setup: 'claude setup-token',
    docsUrl: 'https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp',
    note: 'Claude Agent SDK over ACP. Uses your existing `claude` login (or ANTHROPIC_API_KEY).',
  },
  {
    id: 'claude-code-acp',
    title: 'Claude Code (ACP, Zed)',
    command: 'claude-code-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    install: 'npm install -g @zed-industries/claude-code-acp',
    installPackage: '@zed-industries/claude-code-acp',
    requiresClient: 'claude',
    sandbox: {
      // Anthropic-owned infra wholesale: the API lives on api.anthropic.com,
      // but OAuth token refresh (console.anthropic.com / claude.ai) and
      // telemetry move between subdomains — pinning individual hosts breaks
      // auth ("403 Connection blocked by network allowlist") when they do.
      allowedDomains: ['anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai'],
      homeDirs: ['.claude', '.claude.json', '.claude.json.backup', '.config/claude'],
      // Claude Code hardcodes shell/task bookkeeping under /tmp/claude-<uid>,
      // ignoring $TMPDIR — without this every Bash call fails at mkdir.
      scratchPaths: ['/tmp/claude-${uid}'],
    },
    docsUrl: 'https://www.npmjs.com/package/@zed-industries/claude-code-acp',
    note: "Zed's Claude Code ACP adapter. Auth with `claude /login` or ANTHROPIC_API_KEY.",
  },
  {
    id: 'cursor',
    title: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    // cursor-agent is its own ACP server; the binary is the gate. Not on npm, so
    // auto-setup never installs it (Socket Firewall can't wrap `curl | bash`).
    requiresClient: 'cursor-agent',
    preset: true,
    install: 'curl https://cursor.com/install | bash',
    setup: 'cursor-agent login',
    docsUrl: 'https://docs.cursor.com/en/cli/overview',
    note: 'Cursor CLI as a native ACP server (`cursor-agent acp`). Sign in with `cursor-agent login`.',
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
