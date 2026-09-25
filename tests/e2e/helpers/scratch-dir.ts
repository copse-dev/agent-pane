import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a disposable e2e directory (app profile, Chrome profile) outside the
 * checkout.
 *
 * These used to live in `process.cwd()`. Each holds a whole Copse profile —
 * thread git worktrees, Chromium's cache and databases — and gets rewritten
 * constantly while a spec runs. A file watcher on the checkout (a semantic
 * index, an editor) then receives every one of those writes. gortex's watcher
 * sees them even for excluded paths, and once its event queue overflows it
 * re-patches the whole tree. Every uniquely-named directory also leaked into
 * Copse's derived gortex excludes as its own pattern.
 *
 * The temp root is resolved through `realpath` because macOS `/var` is a
 * symlink to `/private/var`: git reports worktree paths resolved, and specs
 * compare those paths with the profile's configured dirs.
 */
export function makeE2eScratchDir(prefix: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix))
}
