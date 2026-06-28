import type { ApiClient } from '../../preload/api.d.ts'

const CURSOR_AGENT_URL_RE = /cursor\.com\/agents\/(bc-[\w-]+)/

function threadAgentId(container: HTMLElement): string | null {
  const scope = container.closest('.messages-list') ?? container
  for (const link of scope.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const match = link.href.match(CURSOR_AGENT_URL_RE)
    if (match?.[1]) return match[1]
  }
  return null
}

export function hydrateRemoteArtifactImages(
  container: HTMLElement,
  api: { remoteAgent: Pick<ApiClient['remoteAgent'], 'artifactImageDataUrl'> },
): void {
  const agentIdFromThread = threadAgentId(container)
  for (const img of container.querySelectorAll<HTMLImageElement>(
    'img[data-remote-artifact-path]',
  )) {
    if (
      img.dataset['remoteArtifactState'] === 'loading' ||
      img.dataset['remoteArtifactState'] === 'loaded'
    ) {
      continue
    }
    const path = img.dataset['remoteArtifactPath']
    const agentId = img.dataset['remoteArtifactAgentId'] ?? agentIdFromThread
    if (!path || !agentId) {
      img.dataset['remoteArtifactState'] = 'missing-agent'
      continue
    }

    img.dataset['remoteArtifactState'] = 'loading'
    void api.remoteAgent
      .artifactImageDataUrl(agentId, path)
      .then((dataUrl) => {
        img.src = dataUrl
        img.dataset['remoteArtifactState'] = 'loaded'
      })
      .catch((err: unknown) => {
        img.dataset['remoteArtifactState'] = 'error'
        console.warn('[remote-agent] artifact image load failed:', err)
      })
  }
}
