/** Parsed workspace path from a markdown link destination (not http/mailto). */
export interface WorkspaceLinkTarget {
  candidate: string
  line?: number
  column?: number
}

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * Map a markdown `[label](dest)` href to a workspace file index candidate.
 * Strips a leading `/` (repo-root paths), optional `#fragment`, and optional
 * `:line` / `:line:col` suffixes. Returns null for external/unsafe destinations.
 */
export function workspaceLinkTargetFromHref(raw: string): WorkspaceLinkTarget | null {
  let pathPart = raw.trim()
  if (pathPart === '' || pathPart.startsWith('#') || pathPart.startsWith('//')) return null
  if (URL_SCHEME_RE.test(pathPart)) return null

  const hashIdx = pathPart.indexOf('#')
  if (hashIdx >= 0) pathPart = pathPart.slice(0, hashIdx)
  if (pathPart === '') return null

  let line: number | undefined
  let column: number | undefined
  const lineMatch = pathPart.match(/:(\d{1,9})(?::(\d{1,9}))?$/)
  if (lineMatch?.[1] && pathPart.includes('/')) {
    const suffix = lineMatch[0]
    const pathOnly = pathPart.slice(0, pathPart.length - suffix.length)
    if (pathOnly !== '' && !pathOnly.endsWith(':')) {
      pathPart = pathOnly
      line = Number(lineMatch[1])
      if (lineMatch[2] !== undefined) column = Number(lineMatch[2])
    }
  }

  let normalized = pathPart
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('/')) normalized = normalized.slice(1)
  if (normalized === '' || normalized.includes('\\')) return null
  if (
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }

  return {
    candidate: normalized,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  }
}

const COMMONMARK_FIXTURE_SINGLE_SEGMENTS = new Set(['uri', 'url'])

export function isWorkspaceMarkdownLinkHref(raw: string): boolean {
  const target = workspaceLinkTargetFromHref(raw)
  if (!target) return false
  const segments = target.candidate.split('/')
  if (segments.length === 1 && COMMONMARK_FIXTURE_SINGLE_SEGMENTS.has(segments[0] ?? '')) {
    return false
  }
  return true
}
