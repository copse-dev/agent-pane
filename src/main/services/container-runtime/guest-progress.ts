/**
 * What the guest says about the agent's progress while it runs (decision
 * A14). Nobody watches the guest, so the run's log is the only live signal
 * the thread gets, and the first real Codex run showed none for the twenty
 * minutes between "offering 23 native tools" and the agent's final report:
 * the agent's text was written raw and only reached the host on a newline,
 * which its paragraphs rarely carried, and its tool calls were never logged
 * at all. The log now gets one line per tool call as it starts and as it
 * settles, and the agent's text at the boundaries where it stops to act.
 * Pure, so the shape of a line can be tested without a guest.
 */
import type { StreamChunk } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'

const ARGS_LIMIT = 120

/** The one argument that names what a tool is doing, else a short JSON. */
export function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return ''
  const record = args
  for (const key of ['command', 'path', 'query', 'pattern', 'url', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return cut(value.replace(/\s+/g, ' '))
  }
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    return ''
  }
  return json === '{}' ? '' : cut(json)
}

function cut(text: string): string {
  return text.length <= ARGS_LIMIT ? text : `${text.slice(0, ARGS_LIMIT - 1)}…`
}

/**
 * Turns the agent's stream into log lines. Text is held until the agent
 * turns to a tool or finishes its turn, then written whole with a newline so
 * the host's line reader delivers it; a tool call is one line when it starts
 * and one when it settles. Everything else is silent.
 */
export class GuestProgress {
  private pending = ''
  private readonly names = new Map<string, string>()
  private readonly say: (line: string) => void

  constructor(say: (line: string) => void) {
    this.say = say
  }

  /** Write what this chunk means for the log, if anything. */
  handle(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text':
        this.pending += chunk.text
        return
      case 'tool_call': {
        this.flush()
        this.names.set(chunk.toolCall.id, chunk.toolCall.name)
        const args = summarizeToolArgs(chunk.toolCall.args)
        this.say(`[agent] ▶ ${chunk.toolCall.name}${args ? ` ${args}` : ''}\n`)
        return
      }
      case 'tool_call_update': {
        if (chunk.name !== undefined) this.names.set(chunk.toolCallId, chunk.name)
        if (chunk.status === 'done' || chunk.status === 'error') {
          this.settled(chunk.toolCallId, chunk.status === 'error')
        }
        return
      }
      case 'tool_result':
        this.settled(chunk.toolCallId, chunk.isError)
        return
      case 'done':
        this.flush()
        return
      default:
        return
    }
  }

  private settled(toolCallId: string, failed: boolean): void {
    const name = this.names.get(toolCallId) ?? toolCallId
    this.say(`[agent] ${failed ? '✗' : '✓'} ${name}\n`)
  }

  /** Write what the agent has said so far, as one line block. */
  flush(): void {
    const text = this.pending.trim()
    this.pending = ''
    if (text.length === 0) return
    this.say(`[agent] ${text}\n`)
  }
}
