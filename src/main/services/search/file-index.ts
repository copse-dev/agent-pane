import { resolve } from 'node:path'
import { runCommand } from '../exec/command-runner.ts'
import { isRgAvailableForTarget } from '../tool-availability.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { toRelativePathWithinRoot } from '../workspace.ts'
import { indexBuildStarted, indexBuildFinished } from './index-status.ts'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import {
  FILE_INDEX_LIST_MAX_BYTES,
  FILE_INDEX_LIST_TIMEOUT_MS,
} from '../exec/subprocess-output-cap.ts'
import * as fs from 'node:fs/promises'

interface FileIndex {
  paths: string[]
  lastBuilt: number
  memoryBytes: number
}

/**
 * One file index per execution root. A worktree thread runs against a
 * checkout under `~/.copse/worktrees/<project>/<thread>/` — outside the
 * primary workspace root — so a single global index would serve it the
 * shared checkout's file list instead of its own (#1400).
 */
const indexes = new Map<string, FileIndex>()
const buildsInFlight = new Map<string, Promise<void>>()

const LIST_CMD_OPTS = {
  timeout_ms: FILE_INDEX_LIST_TIMEOUT_MS,
  stdoutMaxBytes: FILE_INDEX_LIST_MAX_BYTES,
  lowPriority: true,
} as const

// A conservative retained-heap estimate: JavaScript strings are commonly two
// bytes per code unit, and each array/string entry carries object metadata.
// Exact VM accounting is neither portable nor needed for enforcing a bounded
// dormant-project cache; consistently overestimating is the safer policy.
function estimateIndexMemoryBytes(paths: string[]): number {
  const collectionOverhead = 64
  const entryOverhead = 48
  return paths.reduce((total, path) => total + entryOverhead + path.length * 2, collectionOverhead)
}

function isIndexableRelativePath(rel: string): boolean {
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split('/')
  return !parts.some((part) => part === 'node_modules' || part.startsWith('.'))
}

async function listFilesViaFind(workspaceRoot: string): Promise<string[]> {
  const { stdout, code } = await runCommand('find', [workspaceRoot, '-type', 'f'], {
    ...LIST_CMD_OPTS,
    cwd: workspaceRoot,
  })
  if (code !== 0) return []
  const paths: string[] = []
  for (const full of stdout.split('\n').filter(Boolean)) {
    const rel = await toRelativePathWithinRoot(full, workspaceRoot)
    if (isIndexableRelativePath(rel)) paths.push(rel)
  }
  return paths
}

async function listFilesViaRg(workspaceRoot: string): Promise<string[]> {
  // No `--sort path`: sorting waits for the full walk and slows SSH listings.
  // Sort relative paths in-process after the listing completes.
  const { stdout } = await runCommand('rg', ['--files', workspaceRoot], {
    ...LIST_CMD_OPTS,
    cwd: workspaceRoot,
  })
  const paths = await Promise.all(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((p) => toRelativePathWithinRoot(p, workspaceRoot)),
  )
  paths.sort((a, b) => a.localeCompare(b))
  return paths
}

async function runBuild(key: string, workspaceRoot: string): Promise<void> {
  indexBuildStarted('fileIndex')
  try {
    let paths: string[]
    if (await isRgAvailableForTarget()) {
      paths = await listFilesViaRg(workspaceRoot)
    } else if (isActiveSshWorkspace()) {
      paths = await listFilesViaFind(workspaceRoot)
    } else {
      paths = await walkPaths(workspaceRoot, workspaceRoot)
      paths.sort((a, b) => a.localeCompare(b))
    }
    indexes.set(key, {
      paths,
      lastBuilt: Date.now(),
      memoryBytes: estimateIndexMemoryBytes(paths),
    })
    indexBuildFinished('fileIndex', true)
  } catch (err) {
    indexBuildFinished('fileIndex', false)
    throw err
  } finally {
    buildsInFlight.delete(key)
  }
}

export function buildIndex(workspaceRoot: string): Promise<void> {
  const key = resolve(workspaceRoot)
  // Single-flight per root: concurrent open/watcher/diff-queue callers for the
  // same root share one listing; other roots build independently.
  let inFlight = buildsInFlight.get(key)
  if (!inFlight) {
    inFlight = runBuild(key, workspaceRoot)
    buildsInFlight.set(key, inFlight)
  }
  return inFlight
}

/**
 * Resolve as soon as SOME index is available for this root: immediately when a
 * snapshot exists (even if a rebuild is in flight — `runBuild` only swaps the
 * index in at the end, so a stale snapshot is always coherent), otherwise ride
 * the in-flight build for this root. Workspace open schedules the build
 * without blocking the renderer, so index consumers (find_files, `@` file
 * references, workspace links) briefly wait for the first build here instead
 * of seeing "no index" during boot.
 *
 * Deliberately NOT a wait-for-quiescence loop: the recursive workspace watcher
 * re-arms a rebuild on every file write, so on a busy workspace (an agent
 * writing files, e2e saving screenshots into the repo) `while (buildInFlight)`
 * starved consumers indefinitely — observed as the `@` mention picker hanging
 * past its timeout on CI, where the no-rg walk makes each rebuild slow.
 */
export async function whenFileIndexReady(root: string): Promise<void> {
  const key = resolve(root)
  if (indexes.has(key)) return
  await buildsInFlight.get(key)?.catch(() => undefined)
}

export function getIndex(root: string): FileIndex | null {
  return indexes.get(resolve(root)) ?? null
}

/**
 * Milliseconds since this root was last listed, or null when it has no index.
 *
 * `buildIndex` always re-lists — it is the change response, so it must. Callers
 * that instead *register* a root on every use (a thread switch re-resolves its
 * execution root through several IPCs, #1694) consult this to skip a listing
 * that would only reproduce the snapshot already in hand.
 */
export function getIndexAgeMs(root: string): number | null {
  const entry = indexes.get(resolve(root))
  return entry ? Date.now() - entry.lastBuilt : null
}

/** Conservative retained-heap size for one coherent file-list snapshot. */
export function getIndexMemoryBytes(root: string): number | null {
  return indexes.get(resolve(root))?.memoryBytes ?? null
}

/** Drop the cached index for one root, or every root when called with none. */
export function invalidateIndex(root?: string): void {
  if (root === undefined) {
    indexes.clear()
    return
  }
  indexes.delete(resolve(root))
}

/**
 * Scale evidence for the #795 index policy. Path count comes from the bounded
 * file listing; byte estimate is reserved for a later sampling slice (null today).
 */
export function getIndexStats(
  root: string,
): { pathCount: number; byteEstimate: number | null } | null {
  const entry = indexes.get(resolve(root))
  if (!entry) return null
  return { pathCount: entry.paths.length, byteEstimate: null }
}

/** Test hook — install a fixed file index for a root without scanning it. */
export function setIndexForTest(paths: string[] | null, root: string): void {
  const key = resolve(root)
  if (paths === null) indexes.delete(key)
  else
    indexes.set(key, {
      paths,
      lastBuilt: Date.now(),
      memoryBytes: estimateIndexMemoryBytes(paths),
    })
}

async function walkPaths(root: string, dir: string): Promise<string[]> {
  const paths: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    // Reuse the indexers' ignore list (dist*, vendor, node_modules) at every
    // depth: this fallback runs where rg is absent (e.g. CI containers), and
    // walking build output made each rebuild take tens of seconds there.
    if (e.isDirectory() && isIgnoredWorkspacePath(e.name)) continue
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) paths.push(...(await walkPaths(root, full)))
    else paths.push(await toRelativePathWithinRoot(full, root))
  }
  return paths
}
