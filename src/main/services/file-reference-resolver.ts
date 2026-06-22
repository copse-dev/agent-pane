import { getIndex } from './file-index.ts'

export interface FileReferenceResolution {
  candidate: string
  path: string
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

export function resolveFileReferences(candidates: string[]): FileReferenceResolution[] {
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
      resolutions.push({ candidate, path: normalized })
      continue
    }

    if (normalized.includes('/')) continue

    const basenameMatches = pathsByBasename.get(normalized) ?? []
    if (basenameMatches.length === 1) {
      resolutions.push({ candidate, path: basenameMatches[0]! })
    }
  }
  return resolutions
}
