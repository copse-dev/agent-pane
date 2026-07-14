import { runCommand } from '../exec/command-runner.ts'
import { isRgAvailableForTarget } from '../tool-availability.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { toRelativePath } from '../workspace.ts'
import { indexBuildStarted, indexBuildFinished } from './index-status.ts'
import * as fs from 'node:fs/promises'

interface FileIndex {
  paths: string[]
  lastBuilt: number
}

let index: FileIndex | null = null
let buildInFlight: Promise<void> | null = null

function isIndexableRelativePath(rel: string): boolean {
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split('/')
  return !parts.some((part) => part === 'node_modules' || part.startsWith('.'))
}

async function listFilesViaFind(workspaceRoot: string): Promise<string[]> {
  const { stdout, code } = await runCommand('find', [workspaceRoot, '-type', 'f'])
  if (code !== 0) return []
  const paths: string[] = []
  for (const full of stdout.split('\n').filter(Boolean)) {
    const rel = await toRelativePath(full)
    if (isIndexableRelativePath(rel)) paths.push(rel)
  }
  return paths
}

export async function buildIndex(workspaceRoot: string): Promise<void> {
  indexBuildStarted('fileIndex')
  const build = (async (): Promise<void> => {
    let paths: string[]
    if (await isRgAvailableForTarget()) {
      const { stdout } = await runCommand('rg', ['--files', '--sort', 'path', workspaceRoot])
      paths = await Promise.all(
        stdout
          .split('\n')
          .filter(Boolean)
          .map((p) => toRelativePath(p)),
      )
    } else if (isActiveSshWorkspace()) {
      paths = await listFilesViaFind(workspaceRoot)
    } else {
      paths = await walkPaths(workspaceRoot, workspaceRoot)
    }
    index = { paths, lastBuilt: Date.now() }
  })()
  buildInFlight = build
  try {
    await build
    indexBuildFinished('fileIndex', true)
  } catch (err) {
    indexBuildFinished('fileIndex', false)
    throw err
  } finally {
    if (buildInFlight === build) buildInFlight = null
  }
}

/**
 * Resolve once no file-index build is in flight (immediately when none is).
 * Workspace open schedules the build without blocking the renderer, so index
 * consumers (find_files, `@` file references, workspace links) briefly ride
 * the in-flight build here instead of seeing "no index" during boot.
 */
export async function whenFileIndexReady(): Promise<void> {
  while (buildInFlight) {
    await buildInFlight.catch(() => undefined)
  }
}

export function getIndex(): FileIndex | null {
  return index
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
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) paths.push(...(await walkPaths(root, full)))
    else paths.push(await toRelativePath(full))
  }
  return paths
}
