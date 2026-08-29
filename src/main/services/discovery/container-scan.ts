import * as fsp from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Shared filesystem scan for dot-container contributions — `<.cursor|.claude|
 * .copse|.agents>/<leaf>` trees holding skills, agents, and anything later that
 * follows the same convention.
 *
 * Extracted from the skills registry, which discovered every guard here the
 * hard way. A second consumer that re-derived them would re-derive the bugs
 * too: the worktree duplicate scan in particular is invisible until someone
 * opens this repo in Copse and sees every skill reported twice.
 */

/**
 * Directories a project scan never descends into.
 *
 * The scan looks for `<container>/<leaf>` anywhere under the workspace, so with
 * only `node_modules`/`.git` excluded it walked build output, vendored trees and
 * virtualenvs too — thousands of directories that cannot contain a hand-authored
 * contribution. Worse, Copse's own `dist/` holds the bundled Cursor skills, so a
 * checkout of this repo re-scanned them as "project" skills and logged
 * duplicate warnings against its own build artifacts.
 *
 * Everything here is either generated, vendored, or a package/tool cache. A
 * contribution authored inside one would not survive a clean build anyway.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'out',
  'build',
  'target',
  'vendor',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
])

/**
 * How deep below the workspace root a project scan descends.
 *
 * Containers live near a package root by convention — `.cursor/skills` at the
 * workspace root, or one per package in a monorepo (`packages/x/.cursor/…`).
 * Six levels covers both with room to spare, and bounds the walk on a workspace
 * whose tree is unexpectedly deep (a nested checkout, a huge data directory)
 * rather than letting boot pay for the full traversal.
 */
export const MAX_CONTAINER_ROOT_DEPTH = 6

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Collect every `<container>/<leafName>` directory under `dir`.
 *
 * `containerDirs` is the set of dot-directories whose `leafName` child counts —
 * skills accept `.cursor`/`.agents`/`.claude`, agents accept `.copse`/`.cursor`/
 * `.claude`. A `leafName` directory whose parent is not one of them is treated
 * as an ordinary directory and descended into.
 */
export async function walkForContainerRoots(
  dir: string,
  opts: { containerDirs: ReadonlySet<string>; leafName: string },
  out: Set<string>,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_CONTAINER_ROOT_DEPTH) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // A nested repository — a git worktree, a submodule, a vendored clone — is a
  // separate project that happens to live inside this one. Its contributions are
  // not this workspace's, and for a worktree they are literally the same files on
  // another branch: scanning `.claude/worktrees/*` found every skill again and
  // logged a duplicate warning for each. `.git` is a directory in a clone and a
  // *file* in a worktree, so match on the name and not on its type.
  if (depth > 0 && entries.some((entry) => entry.name === '.git')) return

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.name === opts.leafName) {
      const parent = basename(dirname(full))
      // A container's own leaf dir is the root itself — its subtree holds the
      // contributions, not more containers, so there is nothing below to look for.
      if (opts.containerDirs.has(parent)) {
        out.add(full)
        continue
      }
    }
    await walkForContainerRoots(full, opts, out, depth + 1)
  }
}

/** Recursively visit every file under `root` that `matches`. */
export async function walkForFiles(
  root: string,
  matches: (fileName: string) => boolean,
  onFound: (path: string) => Promise<void>,
): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkForFiles(full, matches, onFound)
      continue
    }
    if (matches(entry.name)) await onFound(full)
  }
}
