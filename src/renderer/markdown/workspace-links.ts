import type { AppStore } from '@shared/store/store.ts'
import { workspaceLinkTargetFromHref } from '@copse/streaming-markdown/host/workspace'
import type { ApiClient } from '../../preload/api.d.ts'
import { getActiveThreadOwner } from '../controller/active-thread-owner.ts'
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
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLAnchorElement>('a[data-workspace-link]')
    if (!link || !root.contains(link)) return
    if (link.dataset['fileReferencePath']) return

    const href = workspaceHrefFromLink(link)
    if (!href) return
    const parsed = workspaceLinkTargetFromHref(href)
    if (!parsed) return
    const owner = getActiveThreadOwner(store)
    // Preserve the leading slash across the IPC boundary. It distinguishes a
    // root-relative Markdown target from the package parser's normalized
    // candidate, and lets main recognize absolute paths emitted by agents.
    const resolutionCandidate =
      owner && href.startsWith('/') ? `/${parsed.candidate}` : parsed.candidate

    event.preventDefault()
    event.stopPropagation()

    void api.index
      .resolveFileReferences([resolutionCandidate], owner ?? undefined)
      .then((resolved) => {
        const currentOwner = getActiveThreadOwner(store)
        if (
          currentOwner?.projectId !== owner?.projectId ||
          currentOwner?.threadId !== owner?.threadId
        )
          return
        const match = resolved.find((entry) => entry.candidate === resolutionCandidate)
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
        const currentOwner = getActiveThreadOwner(store)
        if (
          currentOwner?.projectId !== owner?.projectId ||
          currentOwner?.threadId !== owner?.threadId
        )
          return
        showErrorToast(`Failed to open ${parsed.candidate}`, error)
      })
  }

  root.addEventListener('click', onClick)
  return () => {
    root.removeEventListener('click', onClick)
  }
}
