import type { StreamChunk } from '@shared/types'

/** Keep the client's text API while preserving ACP boundaries in app transcripts. */
export function acpTranscriptChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'text') return chunk
  return {
    type: 'acp_content',
    channel: 'message',
    content: { type: 'text', text: chunk.text },
  }
}
