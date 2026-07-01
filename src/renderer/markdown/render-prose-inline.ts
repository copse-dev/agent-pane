import { renderArtifactImageTags } from './artifact-images.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { type LinkReferenceMap } from './link-references.ts'

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

const HARD_BREAK = '\uFFFE'

/** Apply CommonMark hard breaks (two+ trailing spaces) then soft breaks. */
function applyLineBreaks(text: string, softBreak: 'br' | 'space'): string {
  let body = text.replace(/ {2,}\n/g, HARD_BREAK)
  body = softBreak === 'space' ? body.replace(/\n/g, ' ') : body.replace(/\n/g, '<br>')
  return body.replaceAll(HARD_BREAK, '<br>')
}

export interface RenderProseInlineOptions {
  /** Tight list items collapse single newlines to spaces; default `<br>` (Copse prose). */
  softBreak?: 'br' | 'space'
  linkRefs?: LinkReferenceMap
}

/** Inline markdown for prose blocks and streaming pending tails. */
export function renderProseInline(text: string, options: RenderProseInlineOptions = {}): string {
  const { softBreak = 'br', linkRefs = new Map() } = options
  const body = stripHtmlComments(text)
  const rendered = renderInlineSpans(renderArtifactImageTags(body), linkRefs)
  return applyLineBreaks(rendered, softBreak)
}

/** Like {@link renderProseInline} but skips empty comment-stripped bodies. */
export function renderProseBlock(
  text: string,
  linkRefs: LinkReferenceMap,
  softBreak: 'br' | 'space' = 'br',
): string {
  if (stripHtmlComments(text).trim() === '') return ''
  return renderProseInline(text, { softBreak, linkRefs })
}
