// Reserved `<prefix>:` model-selection namespaces that are NOT extra providers.
//
// Copse encodes a chosen model as `<slug>:<modelId>` for several routing layers
// (OpenRouter, LM Studio, remote cloud agents, device agents, pack routes, and
// every OpenAI-compatible "extra" provider). The extra-provider classifier has
// to tell its own slugs apart from these reserved namespaces, so it needs their
// literal prefixes.
//
// These constants live inside the LLM module (not the app) so the module owns
// the full model-id-namespacing vocabulary and carries no upward import into
// app-specific code — a prerequisite for extracting `@copse/llm` standalone.
// App code that also needs one of these re-exports it from here (see
// ../acp.ts, ../pack-model.ts, ../remote-agent.ts) so there is a single source
// of truth for each literal.
//
// `model-selection.ts` is the parser that consumes all of them; prefer
// `parseModelSelection` over hand-rolling a `startsWith` against these.

/**
 * Model-selection prefix for a remote cloud agent
 * (`remote-agent:<provider>` or `remote-agent:<provider>#<model>`).
 */
export const REMOTE_AGENT_MODEL_PREFIX = 'remote-agent:'

/** Model-selection prefix for an LM Studio local server (`lmstudio:<modelId>`). */
export const LMSTUDIO_MODEL_PREFIX = 'lmstudio:'

/**
 * Model-selection prefix for a locally-spawned device agent
 * (`acp:<agentId>` or `acp:<agentId>#<model>`).
 */
export const ACP_MODEL_PREFIX = 'acp:'

/**
 * Model-selection prefix for a pack-contributed model route
 * (`pack-model:<packId>:<routeId>`, both halves URI-encoded).
 */
export const PACK_MODEL_PREFIX = 'pack-model:'

/**
 * Separator between an agent identity and its chosen model, shared by `acp:`
 * and `remote-agent:`. A model id may contain `[]`, `,`, `=` (e.g.
 * `composer-2.5[fast=true]`) but not `#`, so a first-`#` split is unambiguous.
 */
export const AGENT_MODEL_SEP = '#'
