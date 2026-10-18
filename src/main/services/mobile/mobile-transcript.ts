import type { Message } from '@shared/types'

export interface MobileMessage {
  role: Message['role']
  content: string
  summary: string | null
}

/** Empty assistant records are common around tool calls and carry no readable phone output. */
export function mobileTranscriptMessages(messages: Message[]): MobileMessage[] {
  return messages
    .filter(
      (message) =>
        message.role !== 'assistant' ||
        [message.content, message.runSummary, message.toolSummary, message.commandSummary].some(
          (value) => Boolean(value?.trim()),
        ),
    )
    .slice(-40)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 20_000),
      summary: message.runSummary ?? message.toolSummary ?? message.commandSummary ?? null,
    }))
}
