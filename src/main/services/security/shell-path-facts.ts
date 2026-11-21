import { lstatSync, readlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { SymlinkScopeRequest } from '@copse/shell-guard/shell-scope.ts'

interface ShellPathFact {
  readonly path: string
  readonly kind: 'directory' | 'symlink' | 'other' | 'missing'
}

/**
 * Resolve components in kernel order: a symlink followed by .. climbs from its
 * target, not its lexical parent. Missing leaves are allowed; uncertain paths
 * and symlink loops fail closed. No cache can outlive a link retargeting.
 */
export function resolveShellPath(path: string, followFinalSymlink = true): ShellPathFact | null {
  if (!isAbsolute(path)) return null
  let cursor: string = sep
  let pending = path.split(sep).filter((part) => part !== '' && part !== '.')
  let links = 0
  let kind: ShellPathFact['kind'] = 'directory'
  while (pending.length > 0) {
    const part = pending.shift()
    if (part === undefined) return null
    if (part === '..') {
      cursor = dirname(cursor)
      kind = 'directory'
      continue
    }
    const candidate = join(cursor, part)
    try {
      const entry = lstatSync(candidate)
      if (entry.isSymbolicLink() && (followFinalSymlink || pending.length > 0)) {
        if (++links > 40) return null
        const target = readlinkSync(candidate)
        if (isAbsolute(target)) cursor = sep
        pending = [...target.split(sep).filter((word) => word !== '' && word !== '.'), ...pending]
        continue
      }
      if (pending.length > 0 && !entry.isDirectory()) return null
      cursor = candidate
      kind = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return null
      // A missing intermediate directory followed by .. does not resolve on
      // disk, even if lexical normalization could make it look contained.
      if (pending.includes('..')) return null
      return { path: join(candidate, ...pending), kind: 'missing' }
    }
  }
  return { path: cursor, kind }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

/** Actual ln destination and link-relative target must both remain in the workspace. */
export function isWorkspaceSymlink(request: SymlinkScopeRequest): boolean {
  if (process.platform === 'win32') return false
  // A trailing / or /. forces directory traversal even with ln -n. Keep
  // these spellings out of the literal-link waiver rather than normalizing
  // away the syntax that decides whether the final symlink is followed.
  if (request.linkPath.endsWith('/') || /(?:^|\/)\.$/.test(request.linkPath)) return false
  const root = resolveShellPath(request.workspaceRoot)
  if (root?.kind !== 'directory') return false
  const spelledLink = isAbsolute(request.linkPath)
    ? request.linkPath
    : `${request.workspaceRoot}/${request.linkPath}`
  let link = resolveShellPath(spelledLink, false)
  if (!link) return false
  // ln follows an existing directory destination. -n affects a symlink to a
  // directory only; an actual directory still receives basename(target).
  const followed =
    link.kind === 'symlink' && !request.noDereference ? resolveShellPath(spelledLink) : link
  if (!followed) return false
  if (followed.kind === 'directory') {
    const name = basename(request.target)
    if (name === '.' || name === '..' || name === '') return false
    link = resolveShellPath(`${followed.path}/${name}`, false)
    if (!link) return false
  }
  const target = resolveShellPath(
    isAbsolute(request.target) ? request.target : `${dirname(link.path)}/${request.target}`,
  )
  return target !== null && inside(link.path, root.path) && inside(target.path, root.path)
}
