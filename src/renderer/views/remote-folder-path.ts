/** Parent directory of a remote POSIX path (`/` is its own parent). */
export function parentRemotePath(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

export interface RemotePathSegment {
  /** Display label (`/` for root, otherwise the directory name). */
  label: string
  /** Absolute remote path for this crumb. */
  path: string
}

/** Breadcrumb segments for a remote POSIX path, always starting at `/`. */
export function remotePathSegments(path: string): RemotePathSegment[] {
  const normalized =
    !path || path === '/'
      ? '/'
      : path.startsWith('/')
        ? path.replace(/\/+$/, '') || '/'
        : `/${path}`
  const segments: RemotePathSegment[] = [{ label: '/', path: '/' }]
  if (normalized === '/') return segments
  let acc = ''
  for (const part of normalized.split('/').filter(Boolean)) {
    acc += `/${part}`
    segments.push({ label: part, path: acc })
  }
  return segments
}
