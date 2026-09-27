import { SYSTEM_REMINDER_TAG } from '@copse/agent/hooks/inject-context.ts'

const OPEN = `<${SYSTEM_REMINDER_TAG}>\n`
const CLOSE = `\n</${SYSTEM_REMINDER_TAG}>`
const SEPARATOR = '\n\n'

/** A tool result split into what the tool returned and the notes Copse appended for the model. */
export interface ToolResultWithReminders {
  output: string
  /** Bodies of the appended system-reminder blocks, in the order they were appended. */
  reminders: string[]
}

/**
 * Split off the system-reminder blocks the tool registry appended to a result
 * (argument-clamp notes, a `toolGate` hook's injected context — H2), using the
 * lengths it recorded (`ToolCall.appendedReminderLengths`), so the card can
 * show them as notes instead of raw tags. The text is never searched for tags:
 * tool output that happens to end in a reminder-shaped block stays output.
 * Without lengths (older threads), or when they do not describe the end of
 * `result`, the result is shown raw. Display only: the model and the thread
 * keep the unmodified result.
 */
export function splitAppendedReminders(
  result: string,
  lengths: readonly number[] | undefined,
): ToolResultWithReminders {
  const raw: ToolResultWithReminders = { output: result, reminders: [] }
  if (lengths === undefined || lengths.length === 0) return raw
  let end = result.length
  const reminders: string[] = []
  for (let index = lengths.length - 1; index >= 0; index -= 1) {
    const length = lengths[index]
    if (length === undefined || !Number.isSafeInteger(length) || length < 0) return raw
    const start = end - length
    if (start < SEPARATOR.length) return raw
    const block = result.slice(start, end)
    if (
      !block.startsWith(OPEN) ||
      !block.endsWith(CLOSE) ||
      block.length < OPEN.length + CLOSE.length
    ) {
      return raw
    }
    if (result.slice(start - SEPARATOR.length, start) !== SEPARATOR) return raw
    reminders.unshift(block.slice(OPEN.length, block.length - CLOSE.length))
    end = start - SEPARATOR.length
  }
  return { output: result.slice(0, end), reminders }
}
