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
  /**
   * Absolute scratch paths the agent hardcodes and may read/write; `${uid}`
   * expands to the numeric user id. Needed because some agents ignore the
   * $TMPDIR redirect — Claude Code keeps shell bookkeeping under
   * `/tmp/claude-<uid>` and every Bash call EPERMs without it.
   */
  scratchPaths?: string[]
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
   * Epoch-ms timestamp of the probe that produced {@link availableModels}. Used
   * by the background staleness check (`acpModelsCacheStale`) to re-probe agents
   * whose cache has aged past the TTL, so models the agent gains later (e.g. a
   * new Opus release) reach the picker without a manual "Detect models". Absent
   * on caches written before this field existed — treated as maximally stale, so
   * they refresh on the next workspace open.
   */
  modelsProbedAt?: number
  /**
   * Optional ACP **session mode** to select for each session, as a
   * `SessionModeId` advertised in the agent's `session/new` `modes`
   * (issue #607). ACP surfaces agent permission behavior as session modes —
   * e.g. Claude Code's `default` / `acceptEdits` / `bypassPermissions` / `plan`
   * — so this is how Copse relaxes (or tightens) the agent's own prompting.
   * When set, Copse sends `session/set_mode` right after `session/new`, before
   * the first prompt; when unset the agent keeps its default mode (with one
   * exception: sandboxed Claude presets default to `acceptEdits`, since the
   * seatbelt already contains writes — see `resolveAcpPermissionMode`).
   */
  permissionMode?: string
  /**
   * Session modes the agent advertised the last time it was probed (Settings →
   * "Detect models"), cached so the settings mode picker can list them without
   * re-spawning the agent. Empty/absent when never detected or the agent
   * exposes no session modes.
   */
  availablePermissionModes?: AcpModeChoice[]
  /**
   * Chosen values for the agent's ACP session config options, keyed by
   * `configId` — reasoning level (`thought_level`), mode, or any other selector
   * the agent advertises. Keyed by id rather than category because the id is
   * what `session/set_config_option` takes and the category is only a UX hint
   * (an agent may ship two options in one category, or none at all).
   *
   * Values are validated against the agent's advertised choices at session
   * start: an id the agent no longer offers, or a value no longer in its list,
   * is logged and skipped rather than sent.
   */
  configOptions?: Record<string, string>
  /**
   * Config options the agent advertised the last time it was probed, cached so
   * the composer picker can list reasoning levels/modes without re-spawning the
   * agent. Refreshed on every probe and on every session the agent opens.
   */
  availableConfigOptions?: AcpConfigOption[]
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
  /**
   * Optional agent-provided description of the model. Agents that label their
   * models by family alone put the version here (Claude Code: label "Sonnet",
   * description "Sonnet 5 · Efficient for routine tasks"), so the picker folds
   * it back into the row — see `acpModelChoiceLabel`.
   */
  description?: string
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

/** A selectable session-mode id + label, from an ACP `SessionMode` (issue #607). */
export interface AcpModeChoice {
  /** The `SessionModeId` to persist as {@link AcpAgentConfig.permissionMode}. */
  value: string
  /** Human-readable name for the picker. */
  label: string
  /** Optional agent-provided description of what the mode does. */
  description?: string
}

/**
 * An external ACP agent's session-mode selector, discovered from a `session/new`
 * response (its `modes` state). Surfaced to the settings picker so the user can
 * choose a permission mode to persist on the agent config (issue #607).
 */
export interface AcpModeSelector {
  /** The mode the agent starts a session in when none is selected. */
  currentValue: string
  /** The modes the agent can operate in. */
  choices: AcpModeChoice[]
}

/**
 * Semantic category ACP attaches to a session config option. The spec reserves
 * the un-prefixed names below and is explicit that the field is a **UX hint**:
 * "It MUST NOT be required for correctness. Clients MUST handle missing or
 * unknown categories gracefully." So Copse renders every advertised option
 * regardless, and uses the category only to label and place it —
 * {@link ACP_OTHER_CATEGORY} stands in for absent/unknown/vendor (`_`-prefixed)
 * values.
 */
export type AcpConfigCategory = 'mode' | 'model' | 'model_config' | 'thought_level' | 'other'

/** A selectable value of an ACP config option (`SessionConfigValueId` + label). */
export interface AcpConfigChoice {
  value: string
  label: string
  description?: string
}

/**
 * One `select`-kind ACP session config option, flattened from a `session/new`
 * response. This is the generic form of {@link AcpModelSelector}: the model
 * picker is just the `category: "model"` instance of it, and reasoning level
 * (`thought_level`) and permission mode (`mode`) arrive the same way.
 */
export interface AcpConfigOption {
  /** `configId` used with `session/set_config_option`. */
  configId: string
  /** Agent-provided human-readable label ("Thinking effort", "Mode", …). */
  name: string
  /** UX hint only; `'other'` when absent or unrecognized. */
  category: AcpConfigCategory
  /** Optional agent-provided description of what the option does. */
  description?: string
  /** The value the agent starts a session on when Copse selects nothing. */
  currentValue: string
  /** Flattened choices (option groups expanded). */
  choices: AcpConfigChoice[]
}

/**
 * Combined result of probing an ACP agent (Settings → "Detect models"): the
 * model selector, the session-mode selector, and every other config option the
 * agent advertises, discovered from one throwaway `session/new` so the agent
 * process is spawned only once (issue #607).
 */
export interface AcpAgentProbe {
  /** The agent's model selector, or `null` when it exposes no selectable models. */
  models: AcpModelSelector | null
  /** The agent's session-mode selector, or `null` when it exposes no modes. */
  modes: AcpModeSelector | null
  /**
   * Every `select` config option the agent advertised, including the model one.
   * Cached on the agent config as {@link AcpAgentConfig.availableConfigOptions}
   * so the composer picker can offer reasoning level / mode without re-spawning
   * the agent.
   */
  configOptions?: AcpConfigOption[]
}

/** Outcome of the one-shot ACP preset auto-setup (install/register/detect). */
export interface AcpAutoSetupResult {
  /** Preset ids whose npm adapter was installed via Socket Firewall. */
  installed: string[]
  /**
   * Preset ids whose already-installed npm adapter was upgraded to the registry
   * latest (same Socket-Firewall path as a fresh install).
   */
  upgraded: string[]
  /** Preset ids newly registered as usable agents. */
  registered: string[]
  /** Preset ids whose models were detected and cached. */
  modelsDetected: string[]
  /** Presets that could not be set up, with a short reason. */
  failed: Array<{ id: string; reason: string }>
}
