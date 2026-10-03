// Concise thread view (prototype): a model capable enough to be trusted with its
// own process shows only what it produced — screenshots, visual evidence, canvas
// previews and its closing summary — while its tool calls, reasoning, narration
// and the tool errors it recovers from stay out of the transcript. While it
// works, the activity row (spinner + the one current item) is the whole story.
//
// The gate is the model's Artificial Analysis Intelligence Index on the
// canonical scale, resolved per assistant message so a thread that switches
// models mid-way renders each turn by the model that actually ran it. The
// composite scale is a different ruler (see `intellect-lookup.ts`) and never
// qualifies; an unsourced model keeps the full view.
//
// Experimental and off by default: Settings → Experimental → Concise threads
// (`conciseThreadsEnabled`, held in app state so rendering reads it
// synchronously). With it off, every transcript renders in full.
//
// A turn that *failed* is exempt: the model never saw that error, so it cannot
// have handled it, and hiding it would leave a stopped spinner and nothing else.

import { resolveModelIntellect } from '@copse/llm/intellect-lookup.ts'
import type { Message, Thread, ToolCall } from '@shared/types'
import { formatTodoProgress } from '@shared/todos/todo-logic.ts'
import { getToolCallLabel, shellCommandLabel } from '@shared/tools/tool-display.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** Canonical intellect a model must exceed for its turns to render concisely. */
export const CONCISE_THREAD_MIN_INTELLECT = 50

const conciseByModel = new Map<string, boolean>()

/** True when `model` scores above {@link CONCISE_THREAD_MIN_INTELLECT} on the canonical scale. */
export function isConciseThreadModel(model: string | undefined): boolean {
  if (!model) return false
  const cached = conciseByModel.get(model)
  if (cached !== undefined) return cached
  const intellect = resolveModelIntellect(model)
  const concise = intellect?.scale === 'canonical' && intellect.value > CONCISE_THREAD_MIN_INTELLECT
  conciseByModel.set(model, concise)
  return concise
}

/** The route that ran this message, falling back to the one the user asked for. */
function messageModel(msg: Pick<Message, 'model' | 'requestedModel'>): string | undefined {
  return msg.model ?? msg.requestedModel
}

/** Whether this assistant message renders in the concise view. */
export function isConciseMessage(msg: Pick<Message, 'role' | 'model' | 'requestedModel'>): boolean {
  return msg.role === 'assistant' && isConciseThreadModel(messageModel(msg))
}

/**
 * Whether a concise message carries tool calls, so its text narrates steps
 * unless it is the turn's last bubble (the stylesheet decides that from the DOM,
 * which stays right as later bubbles arrive). A failed turn keeps its text.
 */
export function isConciseStepsMessage(
  msg: Pick<Message, 'role' | 'model' | 'requestedModel' | 'toolCalls' | 'turnOutcome'>,
): boolean {
  return isConciseMessage(msg) && msg.toolCalls.length > 0 && msg.turnOutcome?.status !== 'failed'
}

/**
 * Whether a concise message is process rather than product: a tool is running
 * in it, so its text is narration rather than the summary, and everything but
 * its produced output is hidden. A failed turn keeps its text.
 */
export function isConciseWorkingMessage(
  msg: Pick<Message, 'role' | 'model' | 'requestedModel' | 'toolCalls' | 'turnOutcome'>,
): boolean {
  return (
    isConciseMessage(msg) &&
    msg.toolCalls.some((toolCall) => toolCall.status === 'running') &&
    msg.turnOutcome?.status !== 'failed'
  )
}

/**
 * The id of the user prompt that started the turn `messageId` belongs to: the
 * nearest user message at or before it. Null for messages ahead of any prompt.
 * A turn is the stretch from one prompt to the next, so this identifies it.
 */
export function turnStartId(
  messages: readonly Pick<Message, 'id' | 'role'>[],
  messageId: string,
): string | null {
  const at = messages.findIndex((msg) => msg.id === messageId)
  for (let i = at; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user') return msg.id
  }
  return null
}

/** The id of the newest user prompt: the turn that is live when a thread is running. */
export function liveTurnStartId(messages: readonly Pick<Message, 'id' | 'role'>[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user') return msg.id
  }
  return null
}

/**
 * Toggle the classes the stylesheet keys the concise view on. `enabled` is the
 * experimental setting; with it off both classes are cleared.
 */
export function syncConciseMessageClasses(
  msgEl: HTMLElement,
  msg: Pick<Message, 'role' | 'model' | 'requestedModel' | 'toolCalls' | 'turnOutcome'>,
  enabled: boolean,
): void {
  msgEl.classList.toggle('msg-concise', enabled && isConciseMessage(msg))
  msgEl.classList.toggle('msg-concise-working', enabled && isConciseWorkingMessage(msg))
  msgEl.classList.toggle('msg-concise-steps', enabled && isConciseStepsMessage(msg))
}

/**
 * Whether the thread's live turn is concise: decided by its newest assistant
 * message, or — before the turn's first bubble exists — by the thread's model.
 */
export function isConciseThread(thread: Pick<Thread, 'messages' | 'model'>): boolean {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const msg = thread.messages[i]
    if (msg?.role === 'assistant') return isConciseMessage(msg)
  }
  return isConciseThreadModel(thread.model)
}

function runningToolCall(thread: Pick<Thread, 'messages'>): ToolCall | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const toolCalls = thread.messages[i]?.toolCalls ?? []
    for (let j = toolCalls.length - 1; j >= 0; j--) {
      const tc = toolCalls[j]
      if (tc?.status === 'running' || tc?.subagent?.status === 'running') return tc
    }
  }
  return null
}

function shellCommand(tc: ToolCall): string | null {
  if (tc.name !== 'run_shell' && tc.kind !== 'execute') return null
  const command = isRecord(tc.args) ? tc.args['command'] : undefined
  return typeof command === 'string' && command.trim() ? shellCommandLabel(command) : null
}

/**
 * The activity row's label for a concise turn with a tool in flight. With the
 * cards hidden, the row is the only trace of the work, so it names the specific
 * item (`Editing src/app.ts…`, `Running pnpm test…`) rather than the tool's
 * generic verb. Null when no tool is running — the ordinary label then applies.
 */
export function conciseActivityLabel(
  thread: Pick<Thread, 'status' | 'messages' | 'todos'>,
): string | null {
  if (thread.status !== 'running') return null
  const tc = runningToolCall(thread)
  if (!tc) return null
  const command = shellCommand(tc)
  const base = `${command ? `Running ${command}` : getToolCallLabel({ ...tc, status: 'running' })}…`
  const todoLabel = thread.todos?.length ? formatTodoProgress(thread.todos) : null
  return todoLabel ? `${base} (${todoLabel})` : base
}
