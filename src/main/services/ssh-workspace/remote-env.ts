/** Marker line prefix written by remote wrapped commands so we can capture PGID for kill. */
export const REMOTE_PGID_PREFIX = '__COPSE_PGID__='

/**
 * Small env allow-list for remote exec. Never forward the full local process.env
 * (LLM keys and other secrets must not reach the remote host).
 *
 * Host-local identity vars (PATH/HOME/USER/LOGNAME/SHELL) are intentionally
 * omitted: a macOS client must not stamp its shell path or home directory onto
 * a Linux SSH workspace (interactive PTYs exit immediately on `exec /bin/zsh`).
 */
const REMOTE_ENV_ALLOW = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'COLORTERM',
  'NODE_ENV',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
])

/**
 * Per-command values Copse needs for remote Git backup commits. These are kept
 * separate from the inherited allow-list: callers cannot accidentally forward
 * arbitrary local environment state to the SSH host.
 */
const REMOTE_EXPLICIT_ENV_ALLOW = new Set([
  ...REMOTE_ENV_ALLOW,
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
])

/** Env keys safe to inject into an interactive remote login shell. */
const REMOTE_PTY_ENV_ALLOW = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'COLORTERM',
])

const DEFAULT_REMOTE_LOGIN_SHELL = '/bin/bash'

export function remoteEnvAllowList(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of REMOTE_ENV_ALLOW) {
    const value = base[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key.startsWith('LC_') && !out[key]) out[key] = value
  }
  return out
}

export function mergeRemoteEnv(explicit: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const allowed = remoteEnvAllowList()
  if (!explicit) return allowed
  const out = { ...allowed }
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    if (REMOTE_EXPLICIT_ENV_ALLOW.has(key) || key.startsWith('LC_')) {
      out[key] = value
    }
  }
  return out
}

/**
 * Pick the remote login shell for an interactive PTY. Prefer the probed `$SHELL`
 * from capability discovery; never fall back to the local client's SHELL path.
 */
export function resolveRemoteLoginShell(probed: string | null | undefined): string {
  const trimmed = probed?.trim()
  if (
    trimmed &&
    trimmed.startsWith('/') &&
    !trimmed.includes('\0') &&
    !/\s/.test(trimmed) &&
    !trimmed.includes("'")
  ) {
    return trimmed
  }
  return DEFAULT_REMOTE_LOGIN_SHELL
}

/**
 * Env for interactive remote PTYs. Login shells (`-l`) load the remote profile;
 * only terminal/locale keys are injected so local PATH/HOME/SHELL never override.
 */
export function remotePtyEnv(explicit?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  if (!explicit) return out
  for (const key of REMOTE_PTY_ENV_ALLOW) {
    const value = explicit[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    if (key.startsWith('LC_') && !out[key]) out[key] = value
  }
  return out
}
