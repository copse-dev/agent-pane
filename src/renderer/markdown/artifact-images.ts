import { decodeEscapedHref, escapeHtml } from './escape.ts'

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const decodedTag = decodeEscapedHref(tag)
  for (const match of decodedTag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]
    if (name === undefined) continue
    attrs[name.toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return attrs
}

function artifactImageSource(rawSrc: string): { path: string; agentId?: string } | null {
  if (rawSrc.startsWith('/opt/cursor/artifacts/')) {
    return { path: `artifacts/${rawSrc.slice('/opt/cursor/artifacts/'.length)}` }
  }
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

/** Turn allowed remote-artifact `<img>` tags into lazy placeholders; escape all others. */
export function renderArtifactImageTags(text: string): string {
  return text.replace(/(?:<img\b[\s\S]*?\/?>|&lt;img\b[\s\S]*?\/?&gt;)/gi, (tag) => {
    const attrs = parseHtmlAttributes(tag)
    const artifact = attrs['src'] ? artifactImageSource(attrs['src']) : null
    if (!artifact) return tag
    const alt = attrs['alt'] ?? 'Remote agent artifact'
    const agent = artifact.agentId
      ? ` data-remote-artifact-agent-id="${escapeHtml(artifact.agentId)}"`
      : ''
    return `<img class="remote-artifact-image" data-remote-artifact-path="${escapeHtml(
      artifact.path,
    )}"${agent} alt="${escapeHtml(alt)}" loading="lazy">`
  })
}
