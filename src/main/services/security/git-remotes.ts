import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Read the remote NAMES configured in a repository, straight from `.git/config`.
 *
 * The auto-approval classifier needs this to answer "is `origin` a remote the
 * user actually configured?" before letting a `git fetch` / `git push` run
 * without a prompt. It is read from the file rather than shelled out to `git
 * remote`, because spawning a process inside a permission gate would be both a
 * latency cost on the agent's hot path and a place a `core.pager` /
 * `credential.helper` could execute — the exact class of thing the gate exists to
 * decide about.
 *
 * Only section headers are parsed; remote URLs are deliberately NOT returned. The
 * classifier's safety property is that the command names a remote the user chose,
 * not that the URL looks benign — and parsing URLs would invite exactly that
 * weaker check.
 */

const MAX_CONFIG_BYTES = 1024 * 1024

/** `[remote "origin"]`, tolerating leading whitespace and a trailing comment. */
const REMOTE_SECTION = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/gm

interface CacheEntry {
  /** Identity of the config file the entry was built from. */
  signature: string
  remotes: ReadonlySet<string>
}

const cache = new Map<string, CacheEntry>()

/**
 * Resolve the directory holding the repository's shared `config`.
 *
 * `.git` is a directory in an ordinary clone, and a file containing
 * `gitdir: <path>` in a linked worktree or submodule. A linked worktree's own
 * git dir holds per-worktree state; the remotes live in the *common* dir, named
 * by its `commondir` file.
 */
function resolveGitCommonDir(workspaceRoot: string): string | null {
  const dotGit = join(workspaceRoot, '.git')
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) return null

  let gitDir: string
  try {
    const pointer = readFileSync(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    const target = match?.[1]?.trim()
    if (!target) return null
    gitDir = isAbsolute(target) ? target : resolve(workspaceRoot, target)
  } catch {
    return null
  }

  try {
    const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (commonDir) return isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir)
  } catch {
    // No `commondir` — this git dir is the common one.
  }
  return gitDir
}

/**
 * Remote names configured for the repository at `workspaceRoot`, or an empty set
 * when there is no repository, no config, or nothing readable. An empty set makes
 * the classifier prompt for every network command, which is the safe default.
 *
 * Cached per workspace and invalidated when the config file's size or mtime
 * changes, so a `git remote add` during a session is picked up on the next call.
 */
export function configuredGitRemotes(workspaceRoot: string | null): ReadonlySet<string> {
  if (!workspaceRoot) return new Set()

  const commonDir = resolveGitCommonDir(workspaceRoot)
  if (!commonDir) return new Set()
  const configPath = join(commonDir, 'config')

  let signature: string
  try {
    const stat = statSync(configPath)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return new Set()
    signature = `${configPath}:${String(stat.size)}:${String(stat.mtimeMs)}`
  } catch {
    return new Set()
  }

  const cached = cache.get(workspaceRoot)
  if (cached?.signature === signature) return cached.remotes

  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return new Set()
  }

  const remotes = new Set<string>()
  for (const match of text.matchAll(REMOTE_SECTION)) {
    const name = match[1]?.trim()
    if (name) remotes.add(name)
  }

  cache.set(workspaceRoot, { signature, remotes })
  return remotes
}

/** Drop cached config reads. Exported for tests. */
export function clearGitRemotesCache(): void {
  cache.clear()
}
