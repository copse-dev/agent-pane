import { decodeSafeMarkdownEntities } from './escape.ts'
import { renderArtifactImageTags } from './artifact-images.ts'
import { scanCodeSpans } from './inline-code-spans.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { type LinkReferenceMap } from './link-references.ts'

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

const HARD_BREAK = '\uFFFE'

/**
 * Mark CommonMark hard breaks (two+ trailing spaces, or an odd backslash run,
 * before a newline) with the sentinel *before* inline rendering, so emphasis \u2014
 * which flattens interior newlines to spaces \u2014 cannot erase them. Code-span
 * interiors are skipped (line endings there collapse to spaces instead), as are
 * raw inline `<tag …>` spans (matching the tag protection `applyLineBreaks`
 * gives soft breaks), and a block-final newline never breaks (hard breaks
 * cannot end a block).
 */
const RAW_TAG_LIKE_RE = /^<\/?[a-zA-Z][\s\S]*?>/

function markHardBreaks(text: string): string {
  const { mask } = scanCodeSpans(text)
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '<' && !mask[i]) {
      const tag = RAW_TAG_LIKE_RE.exec(text.slice(i))?.[0]
      if (tag) {
        out += tag
        i += tag.length
        continue
      }
    }
    if (ch !== '\n' || mask[i] || i === text.length - 1) {
      out += ch
      i++
      continue
    }
    let runStart = i
    while (runStart > 0 && text[runStart - 1] === ' ' && !mask[runStart - 1]) runStart--
    const spaces = i - runStart
    let breaks = spaces >= 2
    if (spaces === 0) {
      while (runStart > 0 && text[runStart - 1] === '\\' && !mask[runStart - 1]) runStart--
      const backslashes = i - runStart
      if (backslashes > 0 && backslashes % 2 === 1) {
        breaks = true
        runStart = i - 1 // keep all but the escaping backslash
      } else {
        runStart = i
      }
    }
    if (!breaks) {
      out += ch
      i++
      continue
    }
    out = out.slice(0, out.length - (i - runStart)) + HARD_BREAK
    i++
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  }
  return out
}

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

/** Emit hard-break sentinels as `<br>` and apply the soft-break mode. */
function applyLineBreaks(text: string, softBreak: SoftBreak): string {
  return mapTextOutsideHtmlTags(text, (segment) => {
    let body = segment
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
  const body = markHardBreaks(decodeSafeMarkdownEntities(stripHtmlComments(text)))
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
