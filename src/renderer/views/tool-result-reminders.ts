import { SYSTEM_REMINDER_TAG } from '@copse/agent/hooks/inject-context.ts'

const OPEN = `<${SYSTEM_REMINDER_TAG}>\n`
const CLOSE = `\n</${SYSTEM_REMINDER_TAG}>`

/** A tool result split into what the tool returned and the notes Copse appended for the model. */
export interface ToolResultWithReminders {
  output: string
  /** Bodies of the trailing system-reminder blocks, in the order they were appended. */
  reminders: string[]
}

/**
 * Split the system-reminder blocks the tool registry appends to a result
 * (argument-clamp notes, a `toolGate` hook's injected context — H2) off the
 * tool's own output, so the card can show them as notes instead of raw tags.
 * Display only: the model keeps receiving, and the thread keeps persisting,
 * the unmodified result. Only blocks at the very end are taken, matching how
 * `appendInjectedContext` places them; a result without one passes through.
 */
export function splitTrailingSystemReminders(result: string): ToolResultWithReminders {
  let output = result.trimEnd()
  const reminders: string[] = []
  while (output.endsWith(CLOSE)) {
    const bodyEnd = output.length - CLOSE.length
    const start = output.lastIndexOf(OPEN, bodyEnd)
    if (start === -1) break
    reminders.unshift(output.slice(start + OPEN.length, bodyEnd))
    output = output.slice(0, start).trimEnd()
  }
  return reminders.length === 0 ? { output: result, reminders } : { output, reminders }
}
