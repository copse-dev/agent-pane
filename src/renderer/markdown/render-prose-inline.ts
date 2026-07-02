import { decodeSafeMarkdownEntities } from './escape.ts'
import { renderArtifactImageTags } from './artifact-images.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { type LinkReferenceMap } from './link-references.ts'

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

const HARD_BREAK = '\uFFFE'

/** Apply a line-break transform only outside literal `<…>` tag spans. */
function mapTextOutsideHtmlTags(text: string, mapSegment: (segment: string) => string): string {
  const parts: string[] = []
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) {
      parts.push(mapSegment(text.slice(i)))
      break
    }
    if (lt > i) parts.push(mapSegment(text.slice(i, lt)))
    const gt = text.indexOf('>', lt)
    if (gt === -1) {
      parts.push(text.slice(lt))
      break
    }
    parts.push(text.slice(lt, gt + 1))
    i = gt + 1
  }
  return parts.join('')
}

/** How single newlines inside prose are emitted after inline parsing. */
export type SoftBreak = 'newline' | 'space' | 'br'

/** Apply CommonMark hard breaks (two+ trailing spaces) then soft breaks. */
function applyLineBreaks(text: string, softBreak: SoftBreak): string {
  return mapTextOutsideHtmlTags(text, (segment) => {
    let body = segment.replace(/ {2,}\n/g, HARD_BREAK)
    if (softBreak === 'space') body = body.replace(/\n/g, ' ')
    else if (softBreak === 'br') body = body.replace(/\n/g, '<br>')
    return body.replaceAll(HARD_BREAK, '<br>')
  })
}

export interface RenderProseInlineOptions {
  /** Tight list items use `space`; prose/blockquote/loose lists use CommonMark `newline`. */
  softBreak?: SoftBreak
  linkRefs?: LinkReferenceMap
}

/** Inline markdown for prose blocks and streaming pending tails. */
export function renderProseInline(text: string, options: RenderProseInlineOptions = {}): string {
  const { softBreak = 'newline', linkRefs = new Map() } = options
  const body = decodeSafeMarkdownEntities(stripHtmlComments(text))
  const rendered = renderInlineSpans(renderArtifactImageTags(body), linkRefs)
  return applyLineBreaks(rendered, softBreak)
}

/** Like {@link renderProseInline} but skips empty comment-stripped bodies. */
export function renderProseBlock(
  text: string,
  linkRefs: LinkReferenceMap,
  softBreak: SoftBreak = 'newline',
): string {
  if (stripHtmlComments(text).trim() === '') return ''
  return renderProseInline(text, { softBreak, linkRefs })
}
