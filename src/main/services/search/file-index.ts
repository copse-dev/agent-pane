import { runCommand } from '../exec/command-runner.ts'
import { isRgAvailableForTarget } from '../tool-availability.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { toRelativePath } from '../workspace.ts'
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
}

let index: FileIndex | null = null
let buildInFlight: Promise<void> | null = null

const LIST_CMD_OPTS = {
  timeout_ms: FILE_INDEX_LIST_TIMEOUT_MS,
  stdoutMaxBytes: FILE_INDEX_LIST_MAX_BYTES,
  lowPriority: true,
} as const

function isIndexableRelativePath(rel: string): boolean {
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split('/')
  return !parts.some((part) => part === 'node_modules' || part.startsWith('.'))
}

async function listFilesViaFind(workspaceRoot: string): Promise<string[]> {
  const { stdout, code } = await runCommand('find', [workspaceRoot, '-type', 'f'], LIST_CMD_OPTS)
  if (code !== 0) return []
  const paths: string[] = []
  for (const full of stdout.split('\n').filter(Boolean)) {
    const rel = await toRelativePath(full)
    if (isIndexableRelativePath(rel)) paths.push(rel)
  }
  return paths
}

async function listFilesViaRg(workspaceRoot: string): Promise<string[]> {
  // No `--sort path`: sorting waits for the full walk and slows SSH listings.
  // Sort relative paths in-process after the listing completes.
  const { stdout } = await runCommand('rg', ['--files', workspaceRoot], LIST_CMD_OPTS)
  const paths = await Promise.all(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((p) => toRelativePath(p)),
  )
  paths.sort((a, b) => a.localeCompare(b))
  return paths
}

async function runBuild(workspaceRoot: string): Promise<void> {
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
    index = { paths, lastBuilt: Date.now() }
    indexBuildFinished('fileIndex', true)
  } catch (err) {
    indexBuildFinished('fileIndex', false)
    throw err
  } finally {
    buildInFlight = null
  }
}

export function buildIndex(workspaceRoot: string): Promise<void> {
  // Single-flight: concurrent open/watcher/diff-queue callers share one listing.
  buildInFlight ??= runBuild(workspaceRoot)
  return buildInFlight
}

/**
 * Resolve as soon as SOME index is available: immediately when a snapshot
 * exists (even if a rebuild is in flight — `runBuild` only swaps the index in
 * at the end, so a stale snapshot is always coherent), otherwise ride the one
 * in-flight build. Workspace open schedules the build without blocking the
 * renderer, so index consumers (find_files, `@` file references, workspace
 * links) briefly wait for the first build here instead of seeing "no index"
 * during boot.
 *
 * Deliberately NOT a wait-for-quiescence loop: the recursive workspace watcher
 * re-arms a rebuild on every file write, so on a busy workspace (an agent
 * writing files, e2e saving screenshots into the repo) `while (buildInFlight)`
 * starved consumers indefinitely — observed as the `@` mention picker hanging
 * past its timeout on CI, where the no-rg walk makes each rebuild slow.
 */
export async function whenFileIndexReady(): Promise<void> {
  if (index) return
  await buildInFlight?.catch(() => undefined)
}

export function getIndex(): FileIndex | null {
  return index
}

/**
 * Scale evidence for the #795 index policy. Path count comes from the bounded
 * file listing; byte estimate is reserved for a later sampling slice (null today).
 */
export function getIndexStats(): { pathCount: number; byteEstimate: number | null } | null {
  if (!index) return null
  return { pathCount: index.paths.length, byteEstimate: null }
}

export function invalidateIndex(): void {
  index = null
}

/** Test hook — install a fixed file index without scanning a workspace. */
export function setIndexForTest(paths: string[] | null): void {
  index = paths ? { paths, lastBuilt: Date.now() } : null
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
    else paths.push(await toRelativePath(full))
  }
  return paths
}
