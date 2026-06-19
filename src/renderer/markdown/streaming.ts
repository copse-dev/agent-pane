import { renderMarkdown } from './renderer.ts'

function escapeHtml(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Split streamed content at the last newline so completed lines can be rendered. */
export function splitAtLastNewline(content: string): { complete: string; pending: string } {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
}

/**
 * Render assistant text while it is still streaming.
 * Completed lines (up to the last newline) are markdown-rendered; the
 * in-progress tail stays as plain escaped text until its line ends.
 * Full constructs like tables are finalized on message_done via renderMarkdown().
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitAtLastNewline(content)
  const rendered = complete ? renderMarkdown(complete) : ''
  if (!pending) return rendered
  return `${rendered}<span class="stream-pending">${escapeHtml(pending)}</span>`
}
