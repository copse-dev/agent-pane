import { getSetting } from '../storage/settings.ts'
import { leaseSshAskpassEnv, type SshAskpassLease } from './askpass.ts'

export type SshStrictHostKeys = 'accept-new' | 'strict'

export interface GitSshEnvLease extends SshAskpassLease {
  env: NodeJS.ProcessEnv
}

/** Build `GIT_SSH_COMMAND` for non-interactive git runners (no BatchMode when askpass is wired). */
export function buildGitSshCommand(
  baseEnv: NodeJS.ProcessEnv,
  strictHostKeys: SshStrictHostKeys,
): string {
  if (baseEnv['GIT_SSH_COMMAND']) return baseEnv['GIT_SSH_COMMAND']
  const checking = strictHostKeys === 'strict' ? 'yes' : 'accept-new'
  return `ssh -oStrictHostKeyChecking=${checking}`
}

/**
 * Prepare git/ssh child env: askpass bridge, host-key policy, and the usual
 * non-interactive git tweaks. Call {@link GitSshEnvLease.release} when the
 * child exits.
 */
export function leaseGitSshEnv(baseEnv: NodeJS.ProcessEnv): GitSshEnvLease {
  const askpass = leaseSshAskpassEnv(baseEnv)
  const strictHostKeys = getSetting<SshStrictHostKeys>('sshStrictHostKeys', 'accept-new')
  const hasAskpass = typeof askpass.env['SSH_ASKPASS'] === 'string'
  const gitSshCommand = hasAskpass
    ? buildGitSshCommand(askpass.env, strictHostKeys)
    : (askpass.env['GIT_SSH_COMMAND'] ?? 'ssh -oBatchMode=yes')
  return {
    env: {
      ...askpass.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: gitSshCommand,
    },
    release: askpass.release,
  }
}

/** Shared git argv prefix: no pager, no color. */
export function withGitInvocationArgs(args: string[]): string[] {
  return ['--no-pager', '-c', 'core.pager=cat', '-c', 'color.ui=false', ...args]
}
