import type { ExternalSessionSource, LLMMessage, Message } from '@shared/types'

const SOURCE_NAMES: Readonly<Record<ExternalSessionSource, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** Tool output kept per call in the history a model reads; the transcript keeps more. */
const MAX_TOOL_RESULT_IN_HISTORY = 2000

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${String(text.length - max)} more characters not shown]`
}

/**
 * The provider history an imported thread starts from.
 *
 * Plain text turns only: the CLI's tool calls become a labelled record inside
 * the assistant's turn, never tool calls of the model's own. A model must not
 * read work that ran in another tool, outside Copse's sandbox and approvals,
 * as calls it made itself (and a CLI's raw-string tool inputs are not valid
 * tool arguments for every provider).
 */
export function importedAgentHistory(
  source: ExternalSessionSource,
  messages: readonly Message[],
): LLMMessage[] {
  const tool = SOURCE_NAMES[source]
  const history: LLMMessage[] = []
  let noted = false
  for (const message of messages) {
    if (message.role === 'error') continue
    if (message.role === 'user') {
      const preface = noted
        ? ''
        : `[This conversation was imported from ${tool}. Its earlier turns and tool calls ran in ${tool}, outside Copse's sandbox and approvals.]\n\n`
      noted = true
      history.push({ role: 'user', content: `${preface}${message.content}` })
      continue
    }
    const parts: string[] = []
    if (message.content.trim()) parts.push(message.content)
    for (const call of message.toolCalls) {
      const result = call.result ?? ''
      const what = call.title?.trim() ? call.title : call.name
      parts.push(
        `[${tool} ran ${what}${call.status === 'error' ? ', which failed' : ''}]` +
          (result ? `\n${clip(result, MAX_TOOL_RESULT_IN_HISTORY)}` : ''),
      )
    }
    if (parts.length === 0) continue
    const text = parts.join('\n\n')
    const last = history.at(-1)
    // Consecutive steps of one answer read as one assistant turn.
    if (last?.role === 'assistant' && typeof last.content === 'string')
      last.content = `${last.content}\n\n${text}`
    else history.push({ role: 'assistant', content: text })
  }
  return history
}
