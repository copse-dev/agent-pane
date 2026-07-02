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
