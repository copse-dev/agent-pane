import type { Message, ToolCall } from '@shared/types'

/**
 * Presentation runs: the grouping that lets one tool rollup span several
 * persisted assistant messages.
 *
 * A provider often splits a single burst of work across many assistant
 * messages — prose, then eight tool-only segments — and rolling up per message
 * turned that into eight `Used N tools` rows. A run is the derived view over
 * that sequence: a visible assistant response (or the first tool-only segment
 * after a prompt) starts one, and following tool-only segments join it.
 *
 * This is *derived only*. Nothing here rewrites, merges or reorders persisted
 * messages; the spine and its stream ordering are untouched.
 */

/** The subset of a persisted message that run derivation reads. */
export interface ToolRunMessage {
  id: string
  role: Message['role']
  content: string
  toolCalls?: ToolCall[]
  reasoning?: string
  /** Message-local small-model polish — the heading for this message's step. */
  toolSummary?: string
  /** Run-level small-model polish, carried on the run's anchor message. */
  runSummary?: string
}

/** One member message's contribution to a run. */
export interface ToolRunStep {
  messageId: string
  /** Regular (non-subagent) calls this message contributed, in order. */
  toolCalls: ToolCall[]
  reasoning?: string
  summary?: string
}

export interface ToolRun {
  /** The message the combined rollup renders on — always the run's first. */
  anchorId: string
  /** Every message in the run, in order (`memberIds[0] === anchorId`). */
  memberIds: string[]
  steps: ToolRunStep[]
  /** Every member's regular calls, in message order. */
  toolCalls: ToolCall[]
  summary?: string
}

function regularToolCalls(msg: ToolRunMessage): ToolCall[] {
  return (msg.toolCalls ?? []).filter((tc) => !tc.subagent)
}

function hasText(value: string | undefined): boolean {
  return trimmed(value) !== null
}

/** The value with surrounding space removed, or null when it is blank. */
function trimmed(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  return text.length > 0 ? text : null
}

/** A run can start here: an assistant message that actually ran regular tools. */
function isAnchorable(msg: ToolRunMessage | undefined): boolean {
  return msg !== undefined && msg.role === 'assistant' && regularToolCalls(msg).length > 0
}

/**
 * A run can absorb this message: an assistant segment that carried tools or
 * reasoning but no visible prose. Prose ends a run (it is the model talking to
 * the user again), as does any user/machine prompt or error message.
 */
function isAbsorbable(msg: ToolRunMessage | undefined): boolean {
  if (!msg || msg.role !== 'assistant') return false
  if (hasText(msg.content)) return false
  return regularToolCalls(msg).length > 0 || hasText(msg.reasoning)
}

function stepOf(msg: ToolRunMessage): ToolRunStep {
  const reasoning = msg.reasoning
  const summary = trimmed(msg.toolSummary)
  return {
    messageId: msg.id,
    toolCalls: regularToolCalls(msg),
    ...(reasoning !== undefined && hasText(reasoning) ? { reasoning } : {}),
    ...(summary !== null ? { summary } : {}),
  }
}

/**
 * Group an ordered message sequence into presentation runs. Messages that are
 * not part of any run (prompts, prose-only replies, subagent-only segments)
 * simply produce no run.
 */
export function deriveToolRuns(messages: readonly ToolRunMessage[]): ToolRun[] {
  const runs: ToolRun[] = []
  let i = 0
  while (i < messages.length) {
    const anchor = messages[i]
    i += 1
    if (!isAnchorable(anchor) || !anchor) continue
    const steps = [stepOf(anchor)]
    while (isAbsorbable(messages[i])) {
      const member = messages[i]
      if (!member) break
      steps.push(stepOf(member))
      i += 1
    }
    const summary = trimmed(anchor.runSummary)
    runs.push({
      anchorId: anchor.id,
      memberIds: steps.map((step) => step.messageId),
      steps,
      toolCalls: steps.flatMap((step) => step.toolCalls),
      ...(summary !== null ? { summary } : {}),
    })
  }
  return runs
}

/**
 * The run `messageId` belongs to, or null when it is in none.
 *
 * Derivation is greedy left-to-right, so the answer only depends on the
 * contiguous absorbable stretch around `messageId`: no run can start before the
 * nearest earlier non-absorbable message (it could not have crossed it), and
 * none can continue past the next one. Locating the message is still an
 * O(thread) id scan, but the derivation itself — the part that inspects every
 * tool call — only covers that window, which matters because this runs on
 * every tool-call tick.
 */
export function toolRunForMessage(
  messages: readonly ToolRunMessage[],
  messageId: string,
): ToolRun | null {
  const index = messages.findIndex((m) => m.id === messageId)
  if (index < 0) return null
  let start = index
  while (start > 0 && isAbsorbable(messages[start])) start -= 1
  let end = index + 1
  while (end < messages.length && isAbsorbable(messages[end])) end += 1
  for (const run of deriveToolRuns(messages.slice(start, end))) {
    if (run.memberIds.includes(messageId)) return run
  }
  return null
}
