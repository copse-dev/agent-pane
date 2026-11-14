import { getSetting } from '../storage/settings.ts'
import {
  COPSE_SSH_ASKPASS_NONCE,
  COPSE_SSH_ASKPASS_SOCKET,
  leaseSshAskpassEnv,
  type SshAskpassLease,
} from './askpass.ts'

export type SshStrictHostKeys = 'accept-new' | 'strict'
/** Internal caller policy, never derived from agent/tool arguments. */
export type GitAuthMode = 'interactive' | 'noninteractive'

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
export function leaseGitSshEnv(
  baseEnv: NodeJS.ProcessEnv,
  authMode: GitAuthMode = 'interactive',
): GitSshEnvLease {
  const strictHostKeys = getSetting<SshStrictHostKeys>('sshStrictHostKeys', 'accept-new')
  if (authMode === 'noninteractive') {
    // Replace ambient askpass with a nonce that can only read remembered
    // answers, never ask UI or join a pending foreground prompt. When the
    // bridge is unavailable, explicit unsets survive spawn overlays.
    const askpass = leaseSshAskpassEnv(
      {
        ...baseEnv,
        GIT_ASKPASS: undefined,
        SSH_ASKPASS: undefined,
        SSH_ASKPASS_REQUIRE: 'never',
        [COPSE_SSH_ASKPASS_SOCKET]: undefined,
        [COPSE_SSH_ASKPASS_NONCE]: undefined,
      },
      undefined,
      'cache-only',
    )
    const hasAskpass = typeof askpass.env['SSH_ASKPASS'] === 'string'
    return {
      env: {
        ...askpass.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        // BatchMode would also disable the trusted cache-only SSH helper.
        // Force that helper instead of a terminal; a cache miss exits empty.
        GIT_SSH_COMMAND: `${buildGitSshCommand({}, strictHostKeys)} -oBatchMode=${hasAskpass ? 'no' : 'yes'}`,
        // GCM's documented unattended mode still permits cached credentials.
        GCM_INTERACTIVE: '0',
      },
      release: askpass.release,
    }
  }
  const askpass = leaseSshAskpassEnv(baseEnv)
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
