/**
 * Streaming split driven by block + inline tokenizer state (#475).
 */
import { streamingHoldStart, tokenizeBlocks, type BlockToken } from './block-tokenizer.ts'
import { emphasisSpansNewline, pendingHoldIndex } from './inline-emphasis.ts'

export interface StreamingSplit {
  complete: string
  pending: string
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

  const { complete: lineComplete, pending } = splitAtLastNewline(openText)
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
  }
}

function splitOpenListItem(block: BlockToken, content: string): StreamingSplit {
  const openText = content.slice(block.start)
  const { complete: lineComplete, pending } = splitAtLastNewline(openText)
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
  }
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

  const holdStart = streamingHoldStart(blocks)
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart),
  }
}
