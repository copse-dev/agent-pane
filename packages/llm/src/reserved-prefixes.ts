// Reserved `<prefix>:` model-selection namespaces that are NOT extra providers.
//
// Copse encodes a chosen model as `<slug>:<modelId>` for several routing layers
// (OpenRouter, LM Studio, remote cloud agents, and every OpenAI-compatible
// "extra" provider). The extra-provider classifier has to tell its own slugs
// apart from these reserved namespaces, so it needs their literal prefixes.
//
// These constants live inside the LLM module (not the app) so the module owns
// the full model-id-namespacing vocabulary and carries no upward import into
// app-specific code — a prerequisite for extracting `@copse/llm` standalone.
// App code that also needs `remote-agent:` re-exports it from here (see
// ../remote-agent.ts) so there is a single source of truth for the literal.

/** Model-selection prefix for a remote cloud agent (`remote-agent:<provider>`). */
export const REMOTE_AGENT_MODEL_PREFIX = 'remote-agent:'

/** Model-selection prefix for an LM Studio local server (`lmstudio:<modelId>`). */
export const LMSTUDIO_MODEL_PREFIX = 'lmstudio:'
