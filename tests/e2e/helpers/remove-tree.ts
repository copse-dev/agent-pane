import { rmSync } from 'node:fs'

/**
 * Remove an e2e directory tree (a profile, thread-store project, checkout or
 * fixture root), tolerating a concurrent writer.
 *
 * Spec hooks run while the app is still alive: a thread-store flush, a git
 * worktree or a sandbox mount point can add an entry between the recursive
 * delete emptying a directory and removing it, which fails that `rmdir` with
 * `ENOTEMPTY`. `maxRetries` makes Node retry the whole removal on `EBUSY`,
 * `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM`, waiting `retryDelay` ms longer
 * each attempt (up to ~5.5s in all), so a writer that is finishing up does not
 * fail an unrelated hook. A missing path is still a no-op (`force`), and every
 * other error, or a retryable one that outlasts the retries, still throws.
 *
 * This only absorbs a write that is already in flight. If the app can keep
 * writing to the tree, wait for it to go idle or replace the session first.
 */
export function removeE2eTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
