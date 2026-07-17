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

/**
 * Whether to render a `/` separator after this crumb. Root's label is already
 * `/`, so a separator after it reads as the doubled `/ / usr` path.
 */
export function remotePathShowsSeparatorAfter(segment: RemotePathSegment): boolean {
  return segment.path !== '/'
}

/**
 * Fill a breadcrumb nav for a remote POSIX path. `onNavigate` is called for
 * non-current crumbs; separators are omitted after the root `/` crumb.
 */
export function fillRemotePathBreadcrumbs(
  nav: HTMLElement,
  path: string,
  onNavigate: (path: string) => void,
): void {
  nav.replaceChildren()
  const segments = remotePathSegments(path)
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (!segment) continue
    const isCurrent = i === segments.length - 1
    if (isCurrent) {
      const current = document.createElement('span')
      current.className = 'remote-folder-crumb remote-folder-crumb-current'
      current.textContent = segment.label
      nav.append(current)
      continue
    }
    const crumb = document.createElement('button')
    crumb.type = 'button'
    crumb.className = 'remote-folder-crumb'
    crumb.setAttribute('aria-label', `Go to ${segment.path}`)
    crumb.textContent = segment.label
    crumb.addEventListener('click', () => {
      onNavigate(segment.path)
    })
    nav.append(crumb)
    if (remotePathShowsSeparatorAfter(segment)) {
      const sep = document.createElement('span')
      sep.className = 'remote-folder-crumb-sep'
      sep.setAttribute('aria-hidden', 'true')
      sep.textContent = '/'
      nav.append(sep)
    }
  }
}
