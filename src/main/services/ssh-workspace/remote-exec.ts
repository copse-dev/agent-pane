import { posixQuote } from '../security/safe-install.ts'

/** Build `env KEY=VAL … command` prefix for remote exec (no server SendEnv cooperation needed). */
export function buildRemoteEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return ''
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${posixQuote(value)}`)
  return `env ${pairs.join(' ')} `
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
  const envPrefix = buildRemoteEnvPrefix(env)
  const inner = `${envPrefix}${shellLine}`
  if (!cwd) return inner
  return `cd ${posixQuote(cwd)} && ${inner}`
}
