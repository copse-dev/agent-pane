import type { UserPromptFoldParts, UserPromptFoldRegion } from '../views/user-prompt-fold.ts'

export type UserPromptFoldPiece =
  | { kind: 'markdown'; source: string }
  | { kind: 'code'; source: string }

export type UserPromptFoldMarkdown =
  | { kind: 'fold'; pieces: Record<UserPromptFoldRegion, UserPromptFoldPiece[]> }
  | { kind: 'full'; pieces: UserPromptFoldPiece[] }

interface OpenFence {
  start: number
  bodyStart: number
  opening: string
  marker: string
}

interface Fence extends OpenFence {
  bodyEnd: number
  end: number
}

/** Standalone fence boundaries only; the public Markdown renderer still owns
 * parsing, escaping, indentation and highlighting. Delimiters are classified
 * once in the original prompt, never anew at a fold-region boundary. */
function standaloneFences(source: string): Fence[] | null {
  const fences: Fence[] = []
  let open: OpenFence | undefined
  let offset = 0
  for (const line of source.split('\n')) {
    const next = Math.min(source.length, offset + line.length + 1)
    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*\r?$/.exec(line)?.[1]
      if (closing && closing[0] === open.marker[0] && closing.length >= open.marker.length) {
        fences.push({ ...open, bodyEnd: offset, end: next })
        open = undefined
      }
    } else {
      // Container marker-line fences need the parser's container state. Do
      // not mistake their later indented closer for a root-level opener.
      // Keep the existing generic fold painter for those unsupported contexts.
      if (/^ {0,3}(?:>|[-+*][\t ]|\d+[.)][\t ])/.test(line) && /`{3,}|~{3,}/.test(line)) return null
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(line)
      const marker = match?.[1]
      const info = match?.[2] ?? ''
      if (marker && !(marker.startsWith('`') && info.includes('`'))) {
        open = { start: offset, bodyStart: next, opening: line.replace(/\r$/, ''), marker }
      }
    }
    offset = next
  }
  if (open) fences.push({ ...open, bodyEnd: source.length, end: source.length })
  return fences
}

function piecesInRange(
  source: string,
  fences: readonly Fence[],
  start: number,
  end: number,
): UserPromptFoldPiece[] {
  const pieces: UserPromptFoldPiece[] = []
  let cursor = start
  for (const fence of fences) {
    if (fence.start >= end || fence.end <= start) continue
    if (cursor < fence.start) {
      pieces.push({ kind: 'markdown', source: source.slice(cursor, fence.start) })
    }
    const from = Math.max(start, fence.bodyStart)
    const to = Math.min(end, fence.bodyEnd)
    // A real authored empty block belongs to its opening region. A closing-only
    // fragment of a nonempty spanning block contributes no new empty block.
    const emptyBlock = fence.bodyStart === fence.bodyEnd && fence.start >= start
    if (fence.start >= start && fence.end <= end) {
      // A complete block may belong to a list/container in this region. Keep
      // its actual closer indentation, length and newline byte-for-byte.
      pieces.push({ kind: 'code', source: source.slice(fence.start, fence.end) })
    } else if (from < to || emptyBlock) {
      const body = source.slice(from, Math.max(from, to))
      const indent = /^ */.exec(fence.opening)?.[0] ?? ''
      pieces.push({
        kind: 'code',
        // Balanced wrappers are presentation only. They never enter message
        // storage, resend payloads or the generic arithmetic fold parts.
        source: `${fence.opening}\n${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${indent}${fence.marker}${fence.end <= end && source[fence.end - 1] === '\n' ? '\n' : ''}`,
      })
    }
    cursor = Math.min(end, fence.end)
  }
  if (cursor < end) pieces.push({ kind: 'markdown', source: source.slice(cursor, end) })
  return pieces
}

/** Keep the generic two/one bookends, including their original newline cuts,
 * while carrying a spanning standalone code fence into each clipped region. */
export function userPromptFoldMarkdownPieces(
  source: string,
  parts: UserPromptFoldParts,
  isRootFence: (context: string, code: string) => boolean,
): UserPromptFoldMarkdown | null {
  const fences = standaloneFences(source)
  if (!fences || fences.length === 0) return null
  const hardLines = `${parts.head}\n${parts.middle}\n${parts.tail}`
  const separator = source === hardLines || source === `${hardLines}\n` ? 1 : 0
  if (!separator && source !== parts.head + parts.middle + parts.tail) return null
  const headEnd = parts.head.length + separator
  const middleEnd = headEnd + parts.middle.length + separator
  // Entirely contained blocks already have all their syntax context. Leave
  // that ordinary region render alone unless a fence actually crosses a cut.
  const spanning = fences.filter(
    (fence) =>
      (fence.start < headEnd && fence.end > headEnd) ||
      (fence.start < middleEnd && fence.end > middleEnd),
  )
  if (spanning.length === 0) return null
  for (const fence of spanning) {
    if (!fence.opening.startsWith(' ')) continue
    // The same indentation can open a root fence or continue a list item.
    // Let the public parser decide from the original prefix. Neutral fence
    // info avoids diagram handlers; the terminal code identifies this opener.
    const indent = /^ */.exec(fence.opening)?.[0] ?? ''
    const code = 'copse-fold-context-probe'
    const context = `${source.slice(0, fence.start)}${indent}${fence.marker}\n${indent}${code}\n${indent}${fence.marker}\n`
    if (!isRootFence(context, `${code}\n`)) {
      // Independent region paints would also lose the enclosing container.
      // Keep the whole document and its original code whitespace together.
      return { kind: 'full', pieces: piecesInRange(source, fences, 0, source.length) }
    }
  }
  return {
    kind: 'fold',
    pieces: {
      head: piecesInRange(source, fences, 0, headEnd),
      middle: piecesInRange(source, fences, headEnd, middleEnd),
      tail: piecesInRange(source, fences, middleEnd, source.length),
    },
  }
}
