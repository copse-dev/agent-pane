/**
 * Seatbelt confinement for a spawned ACP agent process (issue #590). When set
 * (and the project sandbox is active), the agent runs under the same
 * workspace-scoped filesystem rules as native auto-run shell commands — writes
 * confined to the workspace, home reads denied — with two agent-specific
 * relaxations: `allowedDomains` (the agent must reach its LLM/auth endpoints)
 * and `homeDirs` (its own config/state directories). When absent the agent
 * spawns unsandboxed, as before.
 */
export interface AcpAgentSandboxConfig {
  /** Domains the agent process may reach (e.g. its model API endpoints). */
  allowedDomains: string[]
  /**
   * Home-relative paths (e.g. `.claude`) the agent may read and write for its
   * own configuration, credentials, and state.
   */
  homeDirs?: string[]
}

/**
 * Configuration for an external ACP agent that Copse (in its **Client role**)
 * can spawn and drive. These are persisted in settings and surfaced in the
 * model picker as `acp:<id>` entries.
 */
export interface AcpAgentConfig {
  /** Stable id; the model value is `acp:<id>`. */
  id: string
  /** Human-readable name shown in the picker (e.g. "Gemini CLI"). */
  title: string
  /** Executable to spawn (absolute path or PATH lookup). */
  command: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Optional model to request for each session, as the `SessionConfigValueId`
   * of the agent's `category: "model"` config option (discovered from
   * `session/new`). When set, Copse sends `session/set_config_option` before the
   * first prompt; when unset the agent uses its own default model.
   */
  model?: string
  /**
   * Models the agent offered the last time it was probed (Settings → "Detect
   * models"), cached so the model picker can list them without re-spawning the
   * agent on every open. Empty/absent when never detected or none are offered.
   */
  availableModels?: AcpModelChoice[]
  /**
   * Per-agent override of the seatbelt confines (issue #590). Absent = use the
   * `KNOWN_ACP_AGENTS` catalog preset for this id (custom agents spawn
   * unsandboxed); an object = custom confines; `false` = explicitly opt out.
   */
  sandbox?: AcpAgentSandboxConfig | false
  enabled: boolean
}

/** A selectable model value + label, flattened from an ACP model config option. */
export interface AcpModelChoice {
  /** The `SessionConfigValueId` to persist as {@link AcpAgentConfig.model}. */
  value: string
  /** Human-readable label for the picker. */
  label: string
}

/**
 * An external ACP agent's model selector, discovered from a `session/new`
 * response (its `category: "model"` config option). Surfaced to the settings
 * picker so the user can choose a model to persist on the agent config.
 */
export interface AcpModelSelector {
  /** `configId` used with `session/set_config_option`. */
  configId: string
  /** The model the agent starts a session on when none is selected. */
  currentValue: string
  /** Flattened choices (option groups expanded). */
  choices: AcpModelChoice[]
}

/** Outcome of the one-shot ACP preset auto-setup (install/register/detect). */
export interface AcpAutoSetupResult {
  /** Preset ids whose npm adapter was installed via Socket Firewall. */
  installed: string[]
  /** Preset ids newly registered as usable agents. */
  registered: string[]
  /** Preset ids whose models were detected and cached. */
  modelsDetected: string[]
  /** Presets that could not be set up, with a short reason. */
  failed: Array<{ id: string; reason: string }>
}
