import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openBrowserUrl, openPullRequest } from '../controller/panels.ts'
import { parseGithubPrUrl } from '@shared/git/github-pr-url.ts'

function linkHttpHref(link: HTMLAnchorElement): string | null {
  const href = link.href
  if (!/^https?:\/\//i.test(href)) return null
  return href
}

function remoteArtifactFromHref(href: string): { agentId: string; path: string } | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const match = url.pathname.match(/^\/v1\/agents\/([^/]+)\/artifacts\/download$/)
  const path = url.searchParams.get('path')
  if (!match?.[1] || !path) return null
  return { agentId: decodeURIComponent(match[1]), path }
}

export function bindBrowserLinkClicks(
  root: HTMLElement,
  store: AppStore,
  api?: {
    remoteAgent: Pick<ApiClient['remoteAgent'], 'downloadArtifact'>
    gh?: Pick<ApiClient['gh'], 'status'>
    shell?: Pick<ApiClient['shell'], 'openExternal'>
  },
): () => void {
  // Marks this container as one whose external links follow the "open links in
  // built-in browser" setting, so CSS can badge them when the setting is off.
  root.classList.add('browser-links-scope')

  // Plain external link: honour the setting. On (default) → in-app browser pane;
  // off → the system browser. The PR-pane and artifact-viewer paths above are
  // in-app features and stay regardless.
  const openPlainLink = (href: string): void => {
    if (!store.getState().openLinksInBuiltInBrowser && api?.shell) {
      void api.shell.openExternal(href)
      return
    }
    openBrowserUrl(store, href)
  }

  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function') return
    const link = (target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!link || !root.contains(link)) return
    if (link.dataset['fileReferencePath']) return
    if (link.dataset['workspaceLink']) return

    const href = linkHttpHref(link)
    if (!href) return

    event.preventDefault()
    event.stopPropagation()
    const artifact = remoteArtifactFromHref(href)
    if (artifact && api) {
      void api.remoteAgent
        .downloadArtifact(artifact.agentId, artifact.path)
        .then((url) => {
          openBrowserUrl(store, url)
        })
        .catch((err: unknown) => {
          console.warn('[remote-agent] artifact download failed:', err)
        })
      return
    }

    const githubPr = parseGithubPrUrl(href)
    if (githubPr && api?.gh) {
      void api.gh.status().then((status) => {
        if (status.installed && status.authenticated) {
          openPullRequest(store, githubPr)
          return
        }
        openPlainLink(href)
      })
      return
    }

    openPlainLink(href)
  }

  root.addEventListener('click', onClick)
  return () => {
    root.removeEventListener('click', onClick)
  }
}
