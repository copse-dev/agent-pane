import { renderArtifactImageTags } from './artifact-images.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { type LinkReferenceMap } from './link-references.ts'

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/** Inline markdown for prose blocks and streaming pending tails (soft breaks → `<br>`). */
export function renderProseInline(text: string, linkRefs: LinkReferenceMap = new Map()): string {
  const body = stripHtmlComments(text)
  const rendered = renderInlineSpans(renderArtifactImageTags(body), linkRefs)
  return rendered.replace(/\n/g, '<br>')
}

/** Like {@link renderProseInline} but skips empty comment-stripped bodies. */
export function renderProseBlock(text: string, linkRefs: LinkReferenceMap): string {
  if (stripHtmlComments(text).trim() === '') return ''
  return renderProseInline(text, linkRefs)
}
