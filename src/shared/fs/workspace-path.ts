const DRIVE_PATH_RE = /^[a-z]:\//i

/**
 * The workspace-relative form of an absolute path: `''` for the root itself,
 * `null` when the path is outside the root or climbs out with `..`. Separators
 * are normalized to `/`, and Windows drive paths compare case-insensitively.
 */
export function workspaceRelativePath(absPath: string, workspaceRoot: string): string | null {
  const path = absPath.replace(/\\/g, '/')
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const foldCase = DRIVE_PATH_RE.test(root)
  const comparablePath = foldCase ? path.toLowerCase() : path
  const comparableRoot = foldCase ? root.toLowerCase() : root
  if (comparablePath === comparableRoot) return ''
  const prefix = comparableRoot === '/' ? '/' : `${comparableRoot}/`
  if (!comparablePath.startsWith(prefix)) return null
  const relative = path.slice(prefix.length)
  return relative.split('/').includes('..') ? null : relative
}

/**
 * The local filesystem path a link or resource URI names: a bare absolute or
 * relative path, or a `file:` URI with no remote host. Other schemes and UNC
 * paths name something that is not a local file, so they return `null`.
 */
export function localPathFromUri(uri: string): string | null {
  if (!uri || uri.startsWith('\\') || uri.startsWith('//')) return null
  if (/^file:/i.test(uri)) {
    let url: URL
    try {
      url = new URL(uri)
    } catch {
      return null
    }
    if (url.host !== '' && url.host.toLowerCase() !== 'localhost') return null
    let path: string
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      return null
    }
    // `file:///C:/x` carries the drive after the authority's slash.
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  }
  // A drive letter looks like a one-letter scheme; anything else with a scheme is remote.
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) return null
  return uri
}
