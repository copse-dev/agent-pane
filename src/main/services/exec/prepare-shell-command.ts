import { errorMessage } from '@shared/errors.ts'
import { spawnRunsOnSshTarget } from '../../project-sandbox/spawn.ts'
import type { PackageFirewallLauncher } from '../security/package-firewall-launcher.ts'
import { detectPackageInstall, wrapWithPackageFirewall } from '../security/safe-install.ts'
import { getSetting } from '../storage/settings.ts'
import { emitShellOutput } from './shell-output-context.ts'

const SHELL_INVOCATION =
  process.platform === 'win32' ? { path: 'cmd', cArg: '/c' } : { path: '/bin/sh', cArg: '-c' }

const winQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`

export type PreparedShellCommand =
  | { command: string; env: NodeJS.ProcessEnv; banner: string }
  | { refused: string }

/**
 * Shared preparation for foreground and background shell execution. Route and
 * approve the raw command, then run the prepared command behind the existing
 * package firewall. The launcher factory is the app-owned executable boundary;
 * both production callers supply packageFirewallLauncher.
 */
export function prepareShellCommand(
  command: string,
  cwd: string,
  launcherFactory: () => PackageFirewallLauncher,
): PreparedShellCommand {
  const baseEnv = process.env
  if (!getSetting<boolean>('safeInstallEnabled', true)) {
    return { command, env: baseEnv, banner: '' }
  }

  const detection = detectPackageInstall(command)
  if (!detection.isInstall) return { command, env: baseEnv, banner: '' }

  const env: NodeJS.ProcessEnv = detection.jsManager
    ? { ...baseEnv, npm_config_ignore_scripts: 'true' }
    : baseEnv
  const banner = detection.jsManager
    ? '[safe-install] install scripts disabled (npm_config_ignore_scripts)\n'
    : ''
  if (banner) emitShellOutput(banner)
  // The desktop's local proxy cannot service a command on an SSH host.
  if (spawnRunsOnSshTarget(cwd)) return { command, env, banner }

  let launcher: PackageFirewallLauncher
  try {
    launcher = launcherFactory()
  } catch (error) {
    return { refused: `Package install cancelled: ${errorMessage(error)}.` }
  }
  const quote = process.platform === 'win32' ? winQuote : undefined
  return {
    command: wrapWithPackageFirewall(command, SHELL_INVOCATION, launcher, quote),
    env,
    banner,
  }
}
