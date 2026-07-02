/**
 * Streaming split driven by block + inline tokenizer state (#475).
 */
import {
  streamingHoldStart,
  TABLE_SEP_RE,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import { emphasisSpansNewline, pendingHoldIndex } from './inline-emphasis.ts'

export interface StreamingSplit {
  complete: string
  pending: string
  /** First line of the open list item when `pending` continues it. */
  openListItemFirstLine?: string
}

/** Split streamed content at the last newline (legacy helper). */
export function splitAtLastNewline(content: string): StreamingSplit {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
}

function splitOpenBlockAtLastNewline(
  block: BlockToken,
  content: string,
  extras: Partial<Omit<StreamingSplit, 'complete' | 'pending'>> = {},
): StreamingSplit {
  const openText = content.slice(block.start)
  const { complete: lineComplete, pending } = splitAtLastNewline(openText)
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
    ...extras,
  }
}

function splitOpenParagraph(block: BlockToken, content: string): StreamingSplit {
  const openText = content.slice(block.start)
  const inlineHold = pendingHoldIndex(openText)

  if (emphasisSpansNewline(openText) && inlineHold >= openText.length) {
    return {
      complete: content.slice(0, block.start),
      pending: content.slice(block.start),
    }
  }

  if (inlineHold < openText.length) {
    const cut = block.start + inlineHold
    return { complete: content.slice(0, cut), pending: content.slice(cut) }
  }

  return splitOpenBlockAtLastNewline(block, content)
}

function openListItemFirstLine(block: BlockToken, content: string): string {
  const slice = content.slice(block.start)
  const nl = slice.indexOf('\n')
  return nl === -1 ? slice : slice.slice(0, nl)
}

function splitOpenListItem(block: BlockToken, content: string): StreamingSplit {
  return splitOpenBlockAtLastNewline(block, content, {
    openListItemFirstLine: openListItemFirstLine(block, content),
  })
}

function splitOpenTable(block: BlockToken, content: string): StreamingSplit {
  const openText = content.slice(block.start)
  const lines = openText.split('\n')
  const sepLine = lines[1]
  if (!sepLine || !TABLE_SEP_RE.test(sepLine)) {
    return {
      complete: content.slice(0, block.start),
      pending: openText,
    }
  }

  const headerSepEnd = (lines[0]?.length ?? 0) + 1 + sepLine.length
  const afterSep = openText.slice(headerSepEnd)
  // Hold header + separator until the separator line is newline-terminated.
  if (!afterSep.startsWith('\n') && lines.length <= 2) {
    return {
      complete: content.slice(0, block.start),
      pending: openText,
    }
  }

  return splitOpenBlockAtLastNewline(block, content)
}

/**
 * Split streaming content at a tokenizer-safe commit boundary. Completed blocks
 * are committed; open, ambiguous, or partially-resolved inline regions stay pending.
 */
export function splitForStreaming(content: string): StreamingSplit {
  const blocks = tokenizeBlocks(content)
  const firstOpen = blocks.find((b) => b.status !== 'complete')

  if (!firstOpen) {
    return splitAtLastNewline(content)
  }

  if (firstOpen.kind === 'paragraph') {
    return splitOpenParagraph(firstOpen, content)
  }

  if (firstOpen.kind === 'list_item') {
    return splitOpenListItem(firstOpen, content)
  }

  if (firstOpen.kind === 'table') {
    return splitOpenTable(firstOpen, content)
  }

  const holdStart = streamingHoldStart(blocks)
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart),
  }
}
