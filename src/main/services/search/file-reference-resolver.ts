import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { getIndex } from './file-index.ts'
import { getWorkspaceRoot, resolvePathWithinRoot, toRelativePathWithinRoot } from '../workspace.ts'

export interface FileReferenceResolution {
  candidate: string
  path: string
  kind: 'file' | 'directory'
}

export interface WorkspaceLinkResolutionContext {
  /** Stable project folder selected by the user. */
  projectRoot: string
  /** `<worktrees root>/<project id>`, containing one directory per thread. */
  managedProjectRoot: string
  /** Offset from a linked checkout's top level to this project's execution root. */
  projectRelativePath: string
}

function relativePathInside(root: string, target: string): string | null {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

function normalizeWorkspaceLinkCandidate(
  candidate: string,
  root: string,
  context: WorkspaceLinkResolutionContext,
): string {
  if (!candidate.startsWith('/')) return candidate

  const fromExecutionRoot = relativePathInside(root, candidate)
  if (fromExecutionRoot) return fromExecutionRoot

  // Links from the shared checkout remain useful after a thread moves into an
  // isolated checkout.
  const fromProjectRoot = relativePathInside(context.projectRoot, candidate)
  if (fromProjectRoot) return fromProjectRoot

  // Agent messages persist longer than their linked worktrees. Rebase a path
  // from any earlier worktree in this same managed project onto the active
  // execution root. This is lexical on purpose: the earlier checkout may have
  // already been retired, while the final containment check still resolves the
  // resulting relative path strictly inside `root`.
  const fromManagedProject = relativePathInside(context.managedProjectRoot, candidate)
  if (fromManagedProject) {
    const [sourceThreadId] = fromManagedProject.split(sep)
    if (sourceThreadId) {
      const sourceExecutionRoot = resolve(
        context.managedProjectRoot,
        sourceThreadId,
        context.projectRelativePath,
      )
      const rebased = relativePathInside(sourceExecutionRoot, candidate)
      if (rebased) return rebased
    }
  }

  // `/docs/file.md` is Copse's established syntax for a workspace-root link.
  return candidate.replace(/^\/+/, '')
}

function normalizeCandidate(
  candidate: string,
  root: string,
  workspaceLinkContext?: WorkspaceLinkResolutionContext,
): string | null {
  let normalized = candidate.trim()
  if (workspaceLinkContext) {
    normalized = normalizeWorkspaceLinkCandidate(normalized, root, workspaceLinkContext)
  }
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
  root: string,
): Promise<FileReferenceResolution | null> {
  try {
    const abs = await resolvePathWithinRoot(normalized, root)
    if (!existsSync(abs)) return null
    const stat = statSync(abs)
    const path = await toRelativePathWithinRoot(abs, root)
    if (stat.isDirectory()) return { candidate, path, kind: 'directory' }
    if (stat.isFile()) return { candidate, path, kind: 'file' }
    return null
  } catch {
    return null
  }
}

export async function resolveFileReferences(
  candidates: string[],
  root: string | null = getWorkspaceRoot(),
  workspaceLinkContext?: WorkspaceLinkResolutionContext,
): Promise<FileReferenceResolution[]> {
  if (!root) return []
  const paths = getIndex(root)?.paths ?? []

  const exactPaths = new Set(paths)
  const pathsByBasename = new Map<string, string[]>()
  for (const path of paths) {
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

    const normalized = normalizeCandidate(candidate, root, workspaceLinkContext)
    if (!normalized) continue

    if (exactPaths.has(normalized)) {
      resolutions.push({ candidate, path: normalized, kind: 'file' })
      continue
    }

    const onDisk = await resolveOnFilesystem(candidate, normalized, root)
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
