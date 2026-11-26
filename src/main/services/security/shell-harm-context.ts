import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isCompiledProgram, readScriptForHarm } from '@copse/shell-guard/script-files.ts'
import {
  TRUSTED_SSH_HOSTS_SETTING,
  sanitizeTrustedSshHosts,
} from '@copse/shell-guard/trusted-ssh-hosts.ts'
import {
  sanitizeTrustedPackageRegistries,
  TRUSTED_PACKAGE_REGISTRIES_SETTING,
} from '@copse/shell-guard/trusted-package-registries.ts'
import {
  PRODUCTION_TARGETS_SETTING,
  sanitizeProductionTargets,
} from '@copse/shell-guard/production-targets.ts'
import { getSetting } from '../storage/settings.ts'
import { assessShellHarm, type ShellHarmContext } from './shell-harm.ts'

/** The user's trusted SSH hosts and a filesystem probe, for the harm gate's host-reach rules. */
export function harmHostReachContext(): Pick<
  ShellHarmContext,
  'trustedSshHosts' | 'trustedPackageRegistries' | 'productionTargets' | 'pathExists'
> {
  return {
    trustedSshHosts: sanitizeTrustedSshHosts(getSetting<unknown>(TRUSTED_SSH_HOSTS_SETTING, [])),
    trustedPackageRegistries: sanitizeTrustedPackageRegistries(
      getSetting<unknown>(TRUSTED_PACKAGE_REGISTRIES_SETTING, []),
    ),
    productionTargets: sanitizeProductionTargets(
      getSetting<unknown>(PRODUCTION_TARGETS_SETTING, []),
    ),
    pathExists: existsSync,
  }
}

/** Whether the Guarded YOLO harm gate would let `command` run, judged on this machine. */
export function localShellHarmAllows(command: string, workspaceRoot: string | null): boolean {
  return (
    assessShellHarm(command, {
      workspaceRoot,
      homeDir: homedir(),
      canonicalizePath: realpathSync.native,
      readScript: readScriptForHarm,
      isCompiledProgram,
      ...harmHostReachContext(),
    }).action === 'allow'
  )
}
