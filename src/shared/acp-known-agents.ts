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
  /**
   * ACP **session mode** (`SessionModeId`) to default the agent into when it
   * spawns **sandboxed** and the user hasn't chosen one (issue #607). The
   * seatbelt already contains writes to the workspace/scratch and the post-turn
   * audit surfaces anything that bypassed the diff queue, so prompt-per-edit
   * adds friction without adding safety — the Claude adapters default to
   * `acceptEdits`. A user-set `permissionMode` always wins; unsandboxed agents
   * keep their own default prompting regardless. The apply step still guards
   * that the agent actually advertises this mode, so a stale value is harmless.
   */
  sandboxedPermissionMode?: string
  /** Shell command that authenticates the agent / mints a token (e.g. `claude setup-token`). */
  setup?: string
  /**
   * Shell command that refreshes an *existing but expired* sign-in. Distinct from
   * {@link setup}: minting a fresh long-lived token (`claude setup-token`) is the
   * first-run path, while an expired OAuth session is fixed by signing in again
   * (`claude /login`). Falls back to {@link setup} when absent — see
   * `acpReauthCommand`.
   */
  reauth?: string
  /** Where to read more about the agent. */
  docsUrl?: string
  /** Short note shown by the detector (auth, caveats). */
  note?: string
}

/**
 * Renames, old id → current id.
 *
 * Copse's agent ids are the [ACP registry](https://github.com/agentclientprotocol/registry)
 * ids, so one vocabulary describes an agent across every client that speaks the
 * protocol. The ids here predate that alignment.
 *
 * These entries are permanent. An id is a persisted key in three places — the
 * `acp:<id>` model value on every thread spine line, the
 * `` `${agentId}:${kind}` `` remembered-permission grants, and
 * `registeredAcpAgents` — and thread history is append-only, so the oldest of
 * those can never be rewritten. Resolve through {@link canonicalAcpAgentId}
 * wherever an id arrives from storage.
 *
 * Only *renames* belong here. An agent that was withdrawn is a
 * {@link RETIRED_ACP_AGENTS} entry keeping its own id: aliasing it to whatever
 * replaced it would make old threads claim they ran something they did not.
 */
export const LEGACY_ACP_AGENT_IDS: Readonly<Record<string, string>> = {
  'claude-agent-acp': 'claude-acp',
  codex: 'codex-acp',
  'gemini-cli': 'gemini',
}

/** Current id for a possibly-legacy one. Unknown ids pass through unchanged. */
export function canonicalAcpAgentId(id: string): string {
  return LEGACY_ACP_AGENT_IDS[id] ?? id
}

/**
 * Agents that were once offered and no longer are. They are deliberately NOT in
 * {@link KNOWN_ACP_AGENTS} — nothing installs, registers, or recommends them —
 * but they keep their full entry here, confinement included, for three reasons:
 *
 *  1. **They must stay sandboxed.** `resolveAcpSandbox` reads the catalog at
 *     spawn time rather than copying the profile into the persisted config, so
 *     an entry that simply disappears downgrades an existing user's agent to
 *     spawning unconfined. Retiring an agent must never relax its seatbelt.
 *  2. `isClaudeAcpAgent` matches by spawn command, so a retired Claude wrapper
 *     must still be recognised as Claude or it loses its Claude-specific
 *     handling and is demoted to the API-billed path in the picker.
 *  3. Threads that ran one stay readable — history stores `acp:<id>` forever,
 *     and without a title the picker label falls back to the raw slug.
 *
 * A retirement is not a rename. `claude-code-acp` must never resolve to
 * `claude-acp`: it was a different adapter, and pointing old threads at the
 * current one would misreport what actually ran. Renames belong in
 * {@link LEGACY_ACP_AGENT_IDS}.
 */
export interface RetiredAcpAgent extends KnownAcpAgent {
  /** Why it went away. Shown in review and in the Settings notice. */
  reason: string
}

export const RETIRED_ACP_AGENTS: readonly RetiredAcpAgent[] = [
  {
    id: 'claude-code-acp',
    // npm marks @zed-industries/claude-code-acp deprecated: "This package
    // has been renamed to @agentclientprotocol/claude-agent-acp." It stopped
    // at 0.16.2 (2026-02-17); the renamed package carries on from 0.24.0.
    reason: 'Renamed upstream to @agentclientprotocol/claude-agent-acp.',
    title: 'Claude Code (ACP, Zed)',
    command: 'claude-code-acp',
    args: [],
    envHints: ['ANTHROPIC_API_KEY'],
    requiresClient: 'claude',
    sandbox: {
      // Anthropic-owned infra wholesale: the API lives on api.anthropic.com,
      // but OAuth token refresh and telemetry move between subdomains — pinning
      // individual hosts breaks auth ("403 Connection blocked by network
      // allowlist") when they do. `claude.com` is not optional: the console
      // moved to platform.claude.com, which is where an OAuth login refreshes
      // its access token. Blocking it doesn't fail loudly — the token simply
      // never refreshes and the next turn dies on "OAuth access token has
      // expired. Re-authenticate to continue."
      allowedDomains: [
        'anthropic.com',
        '*.anthropic.com',
        'claude.ai',
        '*.claude.ai',
        'claude.com',
        '*.claude.com',
      ],
      homeDirs: ['.claude', '.claude.json', '.claude.json.backup', '.config/claude'],
      // Claude Code hardcodes shell/task bookkeeping in system /tmp, ignoring
      // $TMPDIR: a /tmp/claude-<uid>/ tree (every Bash call fails at mkdir
      // without it) and per-command /tmp/claude-<hex>-cwd tracking files.
      // BOTH forms are required: the literal dir gets recursive subpath
      // coverage (ASRT strips trailing /** from write globs, so a glob can
      // never grant a subtree), while the single-segment glob covers the
      // sibling -cwd files.
      scratchPaths: ['/tmp/claude-${uid}', '/tmp/claude-*'],
    },
    sandboxedPermissionMode: 'acceptEdits',
    docsUrl: 'https://www.npmjs.com/package/@zed-industries/claude-code-acp',
    note: "Zed's Claude Code ACP adapter. Auth with `claude /login` or ANTHROPIC_API_KEY.",
  },
]

/**
 * Catalog lookup by id across both the offered and the retired sets. Every
 * resolver that reads the catalog with a **persisted** id must go through this:
 * a config written before an agent was retired still names it, and the answer
 * for "what seatbelt does this spawn under" cannot be "none, it is gone".
 */
export function findAcpCatalogEntry(id: string): KnownAcpAgent | undefined {
  const canonical = canonicalAcpAgentId(id)
  return (
    KNOWN_ACP_AGENTS.find((agent) => agent.id === canonical) ??
    RETIRED_ACP_AGENTS.find((agent) => agent.id === canonical)
  )
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  {
    id: 'gemini',
    title: 'Gemini CLI',
    command: 'gemini',
    // `--acp` is the canonical flag, added in @google/gemini-cli 0.33.0 (2026-03-11);
    // it is what the ACP registry lists for agent id `gemini`. The older
    // `--experimental-acp` still works as a deprecated alias (the CLI computes
    // `isAcpMode = !!argv.acp || !!argv.experimentalAcp`), but it is deprecated in the
    // `--help` text and will eventually be removed, so we track the canonical spelling.
    // Cost of the switch: installs older than 0.33.0 reject `--acp` and need an upgrade.
    args: ['--acp'],
    envHints: ['GEMINI_API_KEY'],
    install: 'npm install -g @google/gemini-cli',
    sandbox: {
      // Google API infra wholesale (model + OAuth endpoints move between
      // *.googleapis.com subdomains) plus the account login host.
      allowedDomains: ['*.googleapis.com', 'accounts.google.com'],
      homeDirs: ['.gemini', '.config/gemini'],
    },
    setup: 'gemini', // first run walks through Google sign-in; or set GEMINI_API_KEY
    reauth: 'gemini', // re-running the CLI re-prompts once the stored token lapses
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    note: 'Sign in by running `gemini` once, or set GEMINI_API_KEY.',
  },
  {
    id: 'claude-acp',
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
      // but OAuth token refresh and telemetry move between subdomains — pinning
      // individual hosts breaks auth ("403 Connection blocked by network
      // allowlist") when they do. `claude.com` is not optional: the console
      // moved to platform.claude.com, which is where an OAuth login refreshes
      // its access token. Blocking it doesn't fail loudly — the token simply
      // never refreshes and the next turn dies on "OAuth access token has
      // expired. Re-authenticate to continue."
      allowedDomains: [
        'anthropic.com',
        '*.anthropic.com',
        'claude.ai',
        '*.claude.ai',
        'claude.com',
        '*.claude.com',
      ],
      homeDirs: ['.claude', '.claude.json', '.claude.json.backup', '.config/claude'],
      // Claude Code hardcodes shell/task bookkeeping in system /tmp, ignoring
      // $TMPDIR: a /tmp/claude-<uid>/ tree (every Bash call fails at mkdir
      // without it) and per-command /tmp/claude-<hex>-cwd tracking files.
      // BOTH forms are required: the literal dir gets recursive subpath
      // coverage (ASRT strips trailing /** from write globs, so a glob can
      // never grant a subtree), while the single-segment glob covers the
      // sibling -cwd files.
      scratchPaths: ['/tmp/claude-${uid}', '/tmp/claude-*'],
    },
    sandboxedPermissionMode: 'acceptEdits',
    setup: 'claude setup-token',
    reauth: 'claude /login',
    docsUrl: 'https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp',
    note: 'Claude Agent SDK over ACP. Uses your existing `claude` login (or ANTHROPIC_API_KEY).',
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
    sandbox: {
      // Cursor-owned infra wholesale: the API lives on cursor.com, but OAuth
      // and telemetry move between subdomains (cursor.sh, etc.) — pinning
      // individual hosts breaks auth when they do.
      allowedDomains: ['cursor.com', '*.cursor.com', 'cursor.sh', '*.cursor.sh'],
      homeDirs: ['.cursor', '.local/share/cursor-agent'],
      // Cursor uses /tmp/.cursor for session bookkeeping (same pattern as
      // Claude's /tmp/claude-<hex> dirs).
      scratchPaths: ['/tmp/.cursor'],
    },
    sandboxedPermissionMode: 'acceptEdits',
    install: 'curl https://cursor.com/install | bash',
    setup: 'cursor-agent login',
    reauth: 'cursor-agent login',
    docsUrl: 'https://docs.cursor.com/en/cli/overview',
    note: 'Cursor CLI as a native ACP server (`cursor-agent acp`). Sign in with `cursor-agent login`.',
  },
  {
    id: 'codex-acp',
    title: 'Codex',
    command: 'codex-acp',
    args: [],
    // Codex reads CODEX_API_KEY (or, as a fallback, OPENAI_API_KEY). OPENAI_API_KEY
    // is scrubbed from the inherited env (child-process-env.ts), so a user relying
    // on it must pass it through the agent's `env`; CODEX_API_KEY survives untouched.
    envHints: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    install: 'npm install -g @agentclientprotocol/codex-acp',
    installPackage: '@agentclientprotocol/codex-acp',
    // Standalone npm adapter (bundles @openai/codex, self-authenticates) — there
    // is no parent client to gate on, so Socket-Firewall auto-setup may install
    // it directly when missing.
    autoInstall: true,
    preset: true,
    sandbox: {
      // OpenAI-owned infra wholesale: the API lives on api.openai.com, but the
      // ChatGPT-login flow talks to chatgpt.com / auth.openai.com and these move
      // between subdomains — pinning individual hosts breaks auth when they do.
      allowedDomains: ['openai.com', '*.openai.com', 'chatgpt.com', '*.chatgpt.com'],
      homeDirs: ['.codex', '.config/codex'],
    },
    setup: 'codex login', // ChatGPT sign-in; set NO_BROWSER=1 for headless, or use CODEX_API_KEY
    reauth: 'codex login',
    docsUrl: 'https://www.npmjs.com/package/@agentclientprotocol/codex-acp',
    note: 'OpenAI Codex over ACP. Sign in with `codex login` (ChatGPT), or set CODEX_API_KEY.',
  },
]

/**
 * Command that re-establishes a lapsed sign-in for a known agent, or `null` when
 * the catalog has no way to sign this agent in (a custom entry, or one that only
 * reads an API key from its environment). Prefers the dedicated {@link
 * KnownAcpAgent.reauth} command and falls back to {@link KnownAcpAgent.setup},
 * which is the right answer for agents whose sign-in is a single step.
 */
export function acpReauthCommand(known: KnownAcpAgent | undefined): string | null {
  return known?.reauth ?? known?.setup ?? null
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
