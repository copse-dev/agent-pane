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
  enabled: boolean
}
