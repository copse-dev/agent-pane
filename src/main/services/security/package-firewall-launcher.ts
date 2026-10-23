import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors.ts'
import { emitShellOutput } from '../exec/shell-output-context.ts'

/**
 * Main-process side of the Copse package firewall (docs/plans/package-firewall.md).
 *
 * The firewall is the standalone `package-firewall.js` bundle, run as Node by
 * the app's own binary. There is nothing to install or approve first: callers
 * put the launcher in front of the command, and every package manager the
 * command starts has its registry downloads checked against public malware
 * advisories.
 */

export interface PackageFirewallLauncher {
  /** The app binary, run with `ELECTRON_RUN_AS_NODE=1`. */
  execPath: string
  scriptPath: string
}

/** The environment the launcher needs on top of the caller's; the firewall removes it again for its child. */
export const PACKAGE_FIREWALL_LAUNCH_ENV: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE: '1',
}

let bundleVerified = false

/** The launcher, or an error naming the missing bundle (a dev build that never emitted it). */
export function packageFirewallLauncher(): PackageFirewallLauncher {
  const scriptPath = join(__dirname, 'package-firewall.js')
  if (!bundleVerified && !existsSync(scriptPath)) {
    throw new Error(
      `the package firewall bundle is missing at ${scriptPath} — run \`pnpm run build\`, ` +
        'or restart `pnpm run dev`, to emit it',
    )
  }
  bundleVerified = true
  return { execPath: process.execPath, scriptPath }
}

/** Launcher arguments for a global npm install with lifecycle scripts disabled. Pure. */
export function globalNpmInstallArgs(
  launcher: PackageFirewallLauncher,
  npmBin: string,
  pkg: string,
): string[] {
  return [launcher.scriptPath, npmBin, 'install', '-g', '--ignore-scripts', pkg]
}

/**
 * Install an npm package **globally** behind the package firewall:
 * `npm install -g --ignore-scripts <pkg>`. The firewall blocks packages (and
 * transitive dependencies) that public advisories list as malicious;
 * `--ignore-scripts` blocks install lifecycle scripts.
 *
 * Callers MUST pass a trusted, hard-coded package spec (e.g. from the
 * `KNOWN_ACP_AGENTS` catalog), never user input, since the spec reaches a shell-
 * free `spawn` of npm. Optional `npmBin` pins the npm that owns an existing
 * global install (the sibling of a resolved agent binary) so upgrades land in
 * the same Node prefix instead of whichever `npm` happens to be first on PATH.
 */
export async function installGlobalNpmPackage(
  pkg: string,
  signal: AbortSignal,
  opts: { npmBin?: string } = {},
): Promise<boolean> {
  const emit = (text: string): void => {
    emitShellOutput(text)
  }
  let launcher: PackageFirewallLauncher
  try {
    launcher = packageFirewallLauncher()
  } catch (error) {
    emit(`[safe-install] ${errorMessage(error)}; aborting package install.\n`)
    return false
  }

  const npmBin = opts.npmBin ?? 'npm'
  emit(
    `[safe-install] installing ${pkg} behind the Copse package firewall ` +
      `(${npmBin} install -g --ignore-scripts ${pkg})…\n`,
  )
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(launcher.execPath, globalNpmInstallArgs(launcher, npmBin, pkg), {
        stdio: 'pipe',
        signal,
        env: { ...process.env, ...PACKAGE_FIREWALL_LAUNCH_ENV },
      })
    } catch {
      resolve(false)
      return
    }
    const stream = (data: Buffer): void => {
      emit(data.toString())
    }
    proc.stdout.on('data', stream)
    proc.stderr.on('data', stream)
    proc.on('error', () => {
      resolve(false)
    })
    proc.on('close', (code) => {
      resolve(code === 0)
    })
  })
}
