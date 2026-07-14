/** Marker line prefix written by remote wrapped commands so we can capture PGID for kill. */
export const REMOTE_PGID_PREFIX = '__COPSE_PGID__='

/**
 * Small env allow-list for remote exec. Never forward the full local process.env
 * (LLM keys and other secrets must not reach the remote host).
 */
const REMOTE_ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
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
    if (REMOTE_ENV_ALLOW.has(key) || key.startsWith('LC_')) {
      out[key] = value
    }
  }
  return out
}
