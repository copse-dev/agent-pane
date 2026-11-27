import { withoutSandboxWrapTmpPin } from '../../project-sandbox/tmp-env.ts'
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

/**
 * Build a string env for subprocesses spawned on behalf of the renderer (no LLM secrets).
 *
 * Also drops the `CLAUDE_CODE_TMPDIR` an in-flight ASRT wrap pins in
 * `process.env` (#4149): an unsandboxed Claude Code started meanwhile would
 * otherwise keep its own temp files in a directory every sandboxed command can
 * write. Sandboxed spawns set their temp variables afterwards.
 */
export function envForRendererChildProcess(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutSandboxWrapTmpPin(base))) {
    if (value === undefined || isSecretEnvKey(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Tool and cloud credentials a command inherits from the user's environment:
 * forge tokens, AWS keys, registry tokens and the like. {@link envForRendererChildProcess}
 * keeps these because an approved command outside the sandbox (`gh`, `aws`,
 * `npm publish`) needs them. A command contained in the project sandbox has no
 * network, so it has no legitimate use for them, and a contained command the
 * harm gate wrongly passed could still print them, write them into the
 * workspace (`env > debug.txt`) or hand them to the next approved step.
 */
const CREDENTIAL_ENV_KEYS = new Set<string>([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'CI_JOB_TOKEN',
  'BITBUCKET_TOKEN',
  'GITEA_TOKEN',
  'FORGEJO_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'ARM_CLIENT_SECRET',
  'ARM_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'YARN_NPM_AUTH_TOKEN',
  'CARGO_REGISTRY_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'UV_PUBLISH_TOKEN',
  'POETRY_PYPI_TOKEN_PYPI',
  'GEM_HOST_API_KEY',
  'DOCKER_PASSWORD',
  'DOCKER_AUTH_CONFIG',
  'HF_TOKEN',
  'VAULT_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

/**
 * Names that hold a credential by convention (`GHCR_PAT`, `SENTRY_AUTH_TOKEN`,
 * `DB_PASSWORD`, `STRIPE_SECRET_KEY`). The suffix must follow `_` or start the
 * name, and a `_FILE` / `_PATH` form names a location rather than the secret.
 */
const CREDENTIAL_NAME_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|SECRET_KEY|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PAT|CREDENTIALS?)$/i

/** A switch such as `HF_HUB_DISABLE_IMPLICIT_TOKEN=1` shares the shape but holds no secret. */
const FLAG_VALUE = /^(?:|0|1|true|false|yes|no|on|off)$/i

/** Whether a variable carries a tool or cloud credential that contained commands must not see. */
export function isCredentialEnvKey(key: string, value: string): boolean {
  if (FLAG_VALUE.test(value.trim())) return false
  return CREDENTIAL_ENV_KEYS.has(key.toUpperCase()) || CREDENTIAL_NAME_PATTERN.test(key)
}

/**
 * The env for a command contained in the project sandbox: the final, merged
 * env with every inherited credential removed. `keep` names the credentials the
 * caller deliberately selected for this run (a scoped network plan's
 * `GH_TOKEN`); everything else, including tokens a caller's overlay copied from
 * `process.env`, is dropped. LLM keys are already gone via
 * {@link envForRendererChildProcess}; this strips them again so the function is
 * safe on any env.
 */
export function envForContainedChildProcess(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): Record<string, string> {
  const kept = new Set(keep)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!kept.has(key) && (isSecretEnvKey(key) || isCredentialEnvKey(key, value))) continue
    out[key] = value
  }
  return out
}
