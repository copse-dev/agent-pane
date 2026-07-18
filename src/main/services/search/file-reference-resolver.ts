import { existsSync, statSync } from 'node:fs'
import { getIndex } from './file-index.ts'
import { getWorkspaceRoot, resolveWorkspacePath, toRelativePath } from '../workspace.ts'

export interface FileReferenceResolution {
  candidate: string
  path: string
  kind: 'file' | 'directory'
}

function normalizeCandidate(candidate: string): string | null {
  let normalized = candidate.trim()
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('\\')) return null
  if (
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }
  return normalized
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** Resolve a path on disk when it is missing from the workspace file index. */
async function resolveOnFilesystem(
  candidate: string,
  normalized: string,
): Promise<FileReferenceResolution | null> {
  if (!getWorkspaceRoot()) return null
  try {
    const abs = await resolveWorkspacePath(normalized)
    if (!existsSync(abs)) return null
    const stat = statSync(abs)
    const path = await toRelativePath(abs)
    if (stat.isDirectory()) return { candidate, path, kind: 'directory' }
    if (stat.isFile()) return { candidate, path, kind: 'file' }
    return null
  } catch {
    return null
  }
}

export async function resolveFileReferences(
  candidates: string[],
): Promise<FileReferenceResolution[]> {
  const idx = getIndex()
  if (!idx) return []

  const exactPaths = new Set(idx.paths)
  const pathsByBasename = new Map<string, string[]>()
  for (const path of idx.paths) {
    const name = basename(path)
    const paths = pathsByBasename.get(name)
    if (paths) paths.push(path)
    else pathsByBasename.set(name, [path])
  }

  const resolutions: FileReferenceResolution[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)

    const normalized = normalizeCandidate(candidate)
    if (!normalized) continue

    if (exactPaths.has(normalized)) {
      resolutions.push({ candidate, path: normalized, kind: 'file' })
      continue
    }

    const onDisk = await resolveOnFilesystem(candidate, normalized)
    if (onDisk) {
      resolutions.push(onDisk)
      continue
    }

    if (normalized.includes('/')) continue

    const basenameMatches = pathsByBasename.get(normalized) ?? []
    const [onlyMatch] = basenameMatches
    if (basenameMatches.length === 1 && onlyMatch !== undefined) {
      resolutions.push({ candidate, path: onlyMatch, kind: 'file' })
    }
  }
  return resolutions
}
