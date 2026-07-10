import type { AppStore } from '@shared/store/store.ts'
import { workspaceLinkTargetFromHref } from '@copse/streaming-markdown/host/workspace'
import type { ApiClient } from '../../preload/api.d.ts'
import { activateWorkspaceReference } from '../controller/files.ts'
import { showErrorToast } from '../views/toast.ts'

function workspaceHrefFromLink(link: HTMLAnchorElement): string | null {
  const raw = link.getAttribute('href')
  if (raw == null || raw === '') return null
  return raw
}

export function bindWorkspaceLinkClicks(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function') return
    const link = (target as Element).closest<HTMLAnchorElement>('a[data-workspace-link]')
    if (!link || !root.contains(link)) return
    if (link.dataset['fileReferencePath']) return

    const href = workspaceHrefFromLink(link)
    if (!href) return
    const parsed = workspaceLinkTargetFromHref(href)
    if (!parsed) return

    event.preventDefault()
    event.stopPropagation()

    void api.index
      .resolveFileReferences([parsed.candidate])
      .then((resolved) => {
        const match = resolved.find((entry) => entry.candidate === parsed.candidate)
        if (!match) {
          showErrorToast(`Could not find ${parsed.candidate} in the workspace`, 'not in index')
          return
        }
        const reveal =
          parsed.line !== undefined
            ? {
                line: parsed.line,
                ...(parsed.column !== undefined ? { column: parsed.column } : {}),
              }
            : undefined
        return activateWorkspaceReference(store, api, match.path, match.kind, reveal)
      })
      .catch((error: unknown) => {
        showErrorToast(`Failed to open ${parsed.candidate}`, error)
      })
  }

  root.addEventListener('click', onClick)
  return () => {
    root.removeEventListener('click', onClick)
  }
}
