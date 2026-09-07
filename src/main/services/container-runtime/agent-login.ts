/**
 * Carrying an agent's desktop sign-in into a container run, on opt-in
 * (`docs/plans/thread-in-container.md`, decision A1′).
 *
 * The host copies the agent's sign-in *files* — a named few under `$HOME`,
 * never a whole directory — into `<runDir>/login/`, which the read-only run
 * mount exposes to the guest; the worker copies them from there into its own
 * throwaway `$HOME` before the agent starts. Nothing is bind-mounted: the
 * agent's token refreshes land in the guest's tmpfs and die with it, and the
 * staged copy on the host is removed the moment the run ends, whatever
 * happened. The staged files are world-readable for that window because the
 * worker uid does not exist on the host — a bounded exposure inside the user's
 * own profile directory, and the reason the copy is deleted in `finally`.
 *
 * Files, not directories, and asynchronously, for a reason that was learned
 * the hard way: `~/.codex` also holds every session transcript the CLI ever
 * wrote, and copying it synchronously on the main process beachballed the app
 * for as long as that took. The sign-in is a few small files; only they cross.
 */
import { existsSync, cpSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where the run directory keeps the staged sign-in; a bare name, no secrets. */
export const LOGIN_STAGE_DIR = 'login'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Host side: copy every sign-in file that exists under `homeDir` into the run
 * directory. Returns the ones that were there. Throws when none was, so a run
 * never starts on the promise of a sign-in the device does not hold.
 */
export async function stageAgentLogin(
  homeDir: string,
  files: readonly string[],
  runDir: string,
  agentTitle: string,
): Promise<string[]> {
  const staged: string[] = []
  const stageRoot = join(runDir, LOGIN_STAGE_DIR)
  await rm(stageRoot, { recursive: true, force: true })
  for (const file of files) {
    const source = join(homeDir, file)
    if (!(await exists(source))) continue
    const target = join(stageRoot, file)
    // The guest reads as a uid the host does not know; the whole stage is
    // deleted when the run ends (see removeStagedLogin).
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    await copyFile(source, target)
    await chmod(target, 0o644)
    staged.push(file)
  }
  if (staged.length === 0) {
    throw new Error(
      `No ${agentTitle} sign-in was found on this device (looked for ${files.map((f) => `~/${f}`).join(', ')}); sign in on the desktop first, or add an API key in Settings.`,
    )
  }
  return staged
}

/** Host side: remove the staged copy. Safe to call when nothing was staged. */
export function removeStagedLogin(runDir: string): void {
  rmSync(join(runDir, LOGIN_STAGE_DIR), { recursive: true, force: true })
}

/**
 * Guest side: copy the staged sign-in into the worker's home, private to the
 * worker. Returns the files restored. Synchronous: it runs once, before the
 * agent, on a handful of small files.
 */
export function restoreAgentLogin(
  runDir: string,
  homeDir: string,
  files: readonly string[],
): string[] {
  const restored: string[] = []
  for (const file of files) {
    const source = join(runDir, LOGIN_STAGE_DIR, file)
    if (!existsSync(source)) continue
    const target = join(homeDir, file)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    cpSync(source, target)
    chmodSync(target, 0o600)
    restored.push(file)
  }
  return restored
}
