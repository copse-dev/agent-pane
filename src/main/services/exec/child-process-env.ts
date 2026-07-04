/**
 * Env vars that must not reach renderer/agent-driven child processes (PTY, run_shell,
 * unsandboxed retries). These are LLM/provider credentials the main process holds;
 * leaking them into a subprocess env makes them directly exfiltratable, especially on
 * an unsandboxed retry with full network (issue #108).
 */
const SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_API_BASE',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'LM_STUDIO_API_KEY',
  'LMSTUDIO_API_KEY',
])

/**
 * Provider-credential patterns — defence in depth for LLM keys not in the explicit
 * list above (e.g. `ANTHROPIC_AUTH_TOKEN`). Deliberately scoped to known LLM/provider
 * prefixes so legitimate tool tokens (GITHUB_TOKEN, NPM_TOKEN, AWS_*) still reach
 * subprocesses that need them.
 */
const SECRET_NAME_PATTERN =
  /^(?:ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|MISTRAL|GROQ|COHERE|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI|HUGGINGFACE|HF|LM_?STUDIO)_.*(?:API_KEY|AUTH_TOKEN|API_TOKEN|SECRET)$/i

function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.has(key) || SECRET_NAME_PATTERN.test(key)
}

/** Build a string env for subprocesses spawned on behalf of the renderer (no LLM secrets). */
export function envForRendererChildProcess(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isSecretEnvKey(key)) continue
    out[key] = value
  }
  return out
}
