import {
  escapeHtml,
  setDefaultConfig,
  type RawImageTag,
  type SanitizeExtension,
} from '@copse/streaming-markdown'

// Remote-agent artifact images. A remote agent emits an <img> whose src is either
// a workspace-relative `artifacts/…` path or the managed download URL
// `…/v1/agents/{id}/artifacts/download?path=artifacts/…`. The core renderer is
// image-agnostic (it escapes every raw <img>); this host policy turns the two
// artifact shapes into an inert, src-less `remote-artifact-image` placeholder that
// `hydrateRemoteArtifactImages()` resolves to a data: URL after sanitization.
const REMOTE_ARTIFACT_IMAGE_CLASS = 'remote-artifact-image'

function artifactImageSource(rawSrc: string): { path: string; agentId?: string } | null {
  if (rawSrc.startsWith('artifacts/')) return { path: rawSrc }

  let url: URL
  try {
    url = new URL(rawSrc)
  } catch {
    return null
  }
  const match = url.pathname.match(/^\/v1\/agents\/([^/]+)\/artifacts\/download$/)
  const path = url.searchParams.get('path')
  if (!match?.[1] || !path?.startsWith('artifacts/')) return null
  return { agentId: decodeURIComponent(match[1]), path }
}

function remoteArtifactImageRenderer({ attrs }: RawImageTag): string | null {
  const src = attrs['src']
  const artifact = src ? artifactImageSource(src) : null
  if (!artifact) return null
  const alt = attrs['alt'] ?? 'Remote agent artifact'
  const agent = artifact.agentId
    ? ` data-remote-artifact-agent-id="${escapeHtml(artifact.agentId)}"`
    : ''
  return `<img class="${REMOTE_ARTIFACT_IMAGE_CLASS}" data-remote-artifact-path="${escapeHtml(
    artifact.path,
  )}"${agent} alt="${escapeHtml(alt)}" loading="lazy">`
}

// Widen the sanitizer just enough to admit the placeholder above, and gate <img>
// to that exact class with no `src` — arbitrary LLM `<img>` (or a claimed class
// with a smuggled `src`/`onerror`) can never survive to `innerHTML`. Hydration
// sets `src` programmatically after sanitization.
const remoteArtifactSanitizeExtension: SanitizeExtension = {
  allowedTags: ['img'],
  allowedAttr: ['data-remote-artifact-path', 'data-remote-artifact-agent-id', 'alt', 'loading'],
  onElement(node: Element, tagName: string): void {
    if (tagName !== 'img') return
    if (node.getAttribute('class') !== REMOTE_ARTIFACT_IMAGE_CLASS) {
      node.remove()
      return
    }
    node.removeAttribute('src')
  },
}

let installed = false

/**
 * Register the remote-agent artifact-image render + sanitize policy as the app's
 * default @copse/streaming-markdown configuration. Call once before any markdown
 * is rendered.
 */
export function installArtifactImagePolicy(): void {
  if (installed) return
  installed = true
  setDefaultConfig({
    rawImageRenderer: remoteArtifactImageRenderer,
    sanitizeExtension: remoteArtifactSanitizeExtension,
  })
}
