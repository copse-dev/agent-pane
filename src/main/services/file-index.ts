import { runCommand } from './command-runner.ts'
import { isRgAvailable } from './tool-availability.ts'
import { toRelativePath } from './workspace.ts'
import * as fs from 'node:fs/promises'

interface FileIndex {
  paths: string[]
  lastBuilt: number
}

let index: FileIndex | null = null

export async function buildIndex(workspaceRoot: string): Promise<void> {
  let paths: string[]
  if (isRgAvailable()) {
    const { stdout } = await runCommand('rg', ['--files', '--sort', 'path', workspaceRoot])
    paths = stdout
      .split('\n')
      .filter(Boolean)
      .map((p) => toRelativePath(p))
  } else {
    paths = await walkPaths(workspaceRoot, workspaceRoot)
  }
  index = { paths, lastBuilt: Date.now() }
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
    else paths.push(toRelativePath(full))
  }
  return paths
}
