import { posixQuote } from '../security/safe-install.ts'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Build `env KEY=VAL … command` prefix for remote exec (no server SendEnv cooperation needed). */
export function buildRemoteEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return ''
  const pairs = Object.entries(env)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .map(([key, value]) => `${key}=${posixQuote(value)}`)
  if (pairs.length === 0) return ''
  return `env ${pairs.join(' ')} `
}

/**
 * `KEY=VAL … ` shell assignments for a line that starts with the `exec`
 * builtin. `env KEY=VAL exec …` would make `env` look for a program named
 * `exec` and fail with exit 127.
 */
function buildRemoteAssignPrefix(env: Record<string, string> | undefined): string {
  const pairs = Object.entries(env ?? {})
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .map(([key, value]) => `${key}=${posixQuote(value)}`)
  return pairs.length > 0 ? `${pairs.join(' ')} ` : ''
}

/** Wrap argv in `cd <cwd> && exec …` when a working directory is requested. */
export function buildRemoteArgvCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  const envPrefix = buildRemoteEnvPrefix(env)
  const cmd = `${envPrefix}${argv.map(posixQuote).join(' ')}`
  if (!cwd) return cmd
  return `cd ${posixQuote(cwd)} && ${cmd}`
}

/** Shell-line remote command with optional cwd/env wrapper. */
export function buildRemoteShellCommand(
  shellLine: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  // A line that `exec`s its program takes the env as shell assignments: `env`
  // cannot run the `exec` builtin.
  const envPrefix = /^exec\s/.test(shellLine)
    ? buildRemoteAssignPrefix(env)
    : buildRemoteEnvPrefix(env)
  const inner = `${envPrefix}${shellLine}`
  if (!cwd) return inner
  return `cd ${posixQuote(cwd)} && ${inner}`
}

/**
 * Interactive remote PTY launch line.
 *
 * Must not use {@link buildRemoteEnvPrefix} (`env KEY=VAL …`) in front of
 * `exec`: `env` treats `exec` as a program name and fails with
 * `env: 'exec': No such file or directory` (exit 127). Use shell assignments
 * before the builtin `exec` instead.
 */
export function buildRemotePtyCommand(
  shell: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  const launch = `${buildRemoteAssignPrefix(env)}exec ${posixQuote(shell)} -l`
  if (!cwd) return launch
  return `cd ${posixQuote(cwd)} && ${launch}`
}
