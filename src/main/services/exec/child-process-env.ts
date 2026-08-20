import { PROVIDER_ENV_VARS } from '../providers/env-key-detection.ts'

/**
 * Env vars that must not reach renderer/agent-driven child processes (PTY, run_shell,
 * unsandboxed retries). These are LLM/provider credentials the main process holds;
 * leaking them into a subprocess env makes them directly exfiltratable, especially on
 * an unsandboxed retry with full network (issue #108).
 *
 * The explicit set is derived from {@link PROVIDER_ENV_VARS} so a newly added
 * provider key cannot be forgotten here the way `CURSOR_API_KEY` was.
 */

/**
 * Provider keys that are not in {@link PROVIDER_ENV_VARS} but are still Copse-held
 * LLM credentials (legacy aliases, extra-provider leftovers, Cursor session cookies).
 * `GITHUB_TOKEN` is intentionally absent — tools such as `gh` need it.
 */
const EXTRA_SECRET_ENV_KEYS = [
  'OPENAI_API_BASE',
  'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'COHERE_API_KEY',
  'XAI_API_KEY',
  'PARALLEL_API_KEY',
  'CURSOR_SESSION_TOKEN',
  'WORKOS_CURSOR_SESSION_TOKEN',
] as const

const SECRET_ENV_KEYS = new Set<string>([
  ...Object.values(PROVIDER_ENV_VARS).flat(),
  ...EXTRA_SECRET_ENV_KEYS,
])

/**
 * Provider-credential patterns — defence in depth for LLM keys not in the explicit
 * list above (e.g. `ANTHROPIC_AUTH_TOKEN`, `CURSOR_SESSION_TOKEN`). Deliberately
 * scoped to known LLM/provider prefixes so legitimate tool tokens (GITHUB_TOKEN,
 * NPM_TOKEN, AWS_*) still reach subprocesses that need them.
 */
const SECRET_NAME_PATTERN =
  /^(?:ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|MISTRAL|GROQ|TOGETHER|FIREWORKS|COHERE|DEEPSEEK|OPENROUTER|PERPLEXITY|PARALLEL|XAI|HUGGINGFACE|HF|LM_?STUDIO|CURSOR|WORKOS_CURSOR)_.*(?:API_KEY|AUTH_TOKEN|API_TOKEN|SECRET|SESSION_TOKEN)$/i

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
