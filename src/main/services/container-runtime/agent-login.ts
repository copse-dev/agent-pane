/**
 * Carrying an agent's desktop sign-in into a container run, on opt-in
 * (`docs/plans/thread-in-container.md`, decision A1′).
 *
 * The host copies the agent's home-relative sign-in directories (the
 * catalogue's `homeDirs`) into `<runDir>/login/`, which the read-only run
 * mount exposes to the guest; the worker copies them from there into its own
 * throwaway `$HOME` before the agent starts. Nothing is bind-mounted: the
 * agent's token refreshes land in the guest's tmpfs and die with it, and the
 * staged copy on the host is removed the moment the run ends, whatever
 * happened. The staged files are world-readable for that window because the
 * worker uid does not exist on the host — a bounded exposure inside the user's
 * own profile directory, and the reason the copy is deleted in `finally`.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Where the run directory keeps the staged sign-in; a bare name, no secrets. */
export const LOGIN_STAGE_DIR = 'login'

function chmodTree(root: string, dirMode: number, fileMode: number): void {
  const info = statSync(root)
  if (info.isDirectory()) {
    chmodSync(root, dirMode)
    for (const entry of readdirSync(root)) chmodTree(join(root, entry), dirMode, fileMode)
  } else {
    chmodSync(root, fileMode)
  }
}

/**
 * Host side: copy every sign-in directory that exists under `homeDir` into the
 * run directory. Returns the ones that were there. Throws when none was, so a
 * run never starts on the promise of a sign-in the device does not hold.
 */
export function stageAgentLogin(
  homeDir: string,
  dirs: readonly string[],
  runDir: string,
  agentTitle: string,
): string[] {
  const staged: string[] = []
  const stageRoot = join(runDir, LOGIN_STAGE_DIR)
  rmSync(stageRoot, { recursive: true, force: true })
  for (const dir of dirs) {
    const source = join(homeDir, dir)
    if (!existsSync(source)) continue
    const target = join(stageRoot, dir)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(source, target, { recursive: true, dereference: true })
    staged.push(dir)
  }
  if (staged.length === 0) {
    throw new Error(
      `No ${agentTitle} sign-in was found on this device (looked in ${dirs.map((d) => `~/${d}`).join(', ')}); sign in on the desktop first, or add an API key in Settings.`,
    )
  }
  // The guest reads as a uid the host does not know; the whole stage is
  // deleted when the run ends (see removeStagedLogin).
  chmodTree(stageRoot, 0o755, 0o644)
  return staged
}

/** Host side: remove the staged copy. Safe to call when nothing was staged. */
export function removeStagedLogin(runDir: string): void {
  rmSync(join(runDir, LOGIN_STAGE_DIR), { recursive: true, force: true })
}

/**
 * Guest side: copy the staged sign-in into the worker's home, private to the
 * worker user. Returns the directories restored.
 */
export function restoreAgentLogin(
  runDir: string,
  homeDir: string,
  dirs: readonly string[],
): string[] {
  const restored: string[] = []
  for (const dir of dirs) {
    const source = join(runDir, LOGIN_STAGE_DIR, dir)
    if (!existsSync(source)) continue
    const target = join(homeDir, dir)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(source, target, { recursive: true })
    chmodTree(target, 0o700, 0o600)
    restored.push(dir)
  }
  return restored
}
