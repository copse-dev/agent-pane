/** Env vars that must not reach renderer-driven child processes (PTY, etc.). */
const SECRET_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])

/** Build a string env for subprocesses spawned on behalf of the renderer (no LLM secrets). */
export function envForRendererChildProcess(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SECRET_ENV_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}
