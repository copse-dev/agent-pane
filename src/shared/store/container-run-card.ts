/**
 * A container run as a turn on the thread that launched it
 * (`docs/plans/thread-in-container.md`, decision A13).
 *
 * The run itself belongs to the main process and is session-only; what the
 * thread keeps is one assistant message holding a `container_run` tool call
 * whose subagent session is the run: the task as the prompt, the guest's
 * transcript as the timeline, the review record as the result. The card is
 * rebuilt from every progress snapshot and written back over the same tool
 * call id, so the thread shows the run advancing and, once it settles, keeps
 * it — the spine persists a tool call only when it is no longer running, so a
 * run the app quit on leaves no half-card behind.
 */
import type { ContainerRunProgress } from '../types/container-run.ts'
import type { SubagentMessage, SubagentSession, ToolCall } from '@shared/types'
import type { AppStore } from './store.ts'
import {
  addMessage,
  addToolCall,
  findToolCallOwner,
  getThreadById,
  updateToolCall,
} from './thread-helpers.ts'

export const CONTAINER_RUN_TOOL = 'container_run'
/**
 * Dispatched (bubbling) by the card's follow-up button with
 * `{ runtimeId, toolCallId }`; the run control listens on the document and
 * does the work, so the card needs neither the API nor the store.
 */
export const CONTAINER_RUN_ADOPT_EVENT = 'container-run-adopt'

/** What the card carries as the call's arguments: the ask, and the run it became. */
export interface ContainerRunToolArgs {
  task: string
  model: string
  runtimeId: string | null
  /** Where the guest's commits landed, once fetched; what a follow-up applies. */
  ref: string | null
}

export function containerRunToolCallId(
  progress: Pick<ContainerRunProgress, 'threadId' | 'startedAt'>,
): string {
  return `container-run:${progress.threadId}:${String(progress.startedAt)}`
}

function isLive(progress: ContainerRunProgress): boolean {
  return progress.phase !== 'finished' && progress.phase !== 'failed'
}

function cardStatus(progress: ContainerRunProgress): ToolCall['status'] {
  if (isLive(progress)) return 'running'
  return progress.phase === 'finished' ? 'done' : 'error'
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

function minutes(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  return seconds < 90 ? `${String(seconds)}s` : `${String(Math.round(seconds / 60))} min`
}

/** One line on what the run came to; null while it is still going. */
export function containerRunSummary(progress: ContainerRunProgress): string | null {
  if (isLive(progress)) return null
  const result = progress.record?.result ?? null
  const ref = progress.record?.carryOut.ref ?? null
  if (progress.phase === 'failed') return `Failed: ${progress.error ?? 'the run did not complete'}`
  if (!result) return 'Finished without a result'
  const commits =
    result.commits.length === 0
      ? 'no commits'
      : `${plural(result.commits.length, 'commit')} ${ref ? `on ${ref}` : 'made but not fetched'}`
  return `Finished: ${commits}, ${plural(result.deferrals.length, 'effect')} waiting for review, ${plural(result.denials.length, 'effect')} refused.`
}

/** The review record as the card's result, in Markdown; null while running. */
export function containerRunResultMarkdown(progress: ContainerRunProgress): string | null {
  if (isLive(progress)) return null
  const record = progress.record
  const result = record?.result ?? null
  const lines: string[] = []
  const summary = containerRunSummary(progress)
  if (summary) lines.push(`**${summary}**`)
  const facts: string[] = [`model ${progress.model}`]
  if (result) {
    facts.push(
      result.harness === 'copse' ? 'Copse harness' : `${result.harness.acp} agent`,
      `${String(result.usage.inputTokens)} in / ${String(result.usage.outputTokens)} out`,
    )
  }
  if (progress.finishedAt !== null) facts.push(minutes(progress.startedAt, progress.finishedAt))
  lines.push(facts.join(' · '))
  if (result && result.commits.length > 0) {
    lines.push('', ...result.commits.map((line) => `- \`${line}\``))
  }
  if (progress.warnings.length > 0) {
    lines.push(
      '',
      '**Needs your attention**',
      ...progress.warnings.map((warning) => `- ${warning}`),
    )
  }
  if (result && result.deferrals.length > 0) {
    lines.push(
      '',
      '**Waiting for your review**',
      ...result.deferrals.map(
        (entry) =>
          `- ${entry.title}${entry.reasons?.length ? ` — ${entry.reasons.join('; ')}` : ''}`,
      ),
    )
  }
  if (result && result.denials.length > 0) {
    lines.push(
      '',
      '**Refused by the container policy**',
      ...result.denials.map(
        (entry) =>
          `- ${entry.subject}${entry.reasons.length > 0 ? ` — ${entry.reasons.join('; ')}` : ''}`,
      ),
    )
  }
  if (result?.finalText) lines.push('', result.finalText)
  return lines.join('\n')
}

/** The run's log tail as one timeline message, so a live card shows movement. */
function logMessage(progress: ContainerRunProgress): SubagentMessage | null {
  if (progress.log.length === 0) return null
  return {
    id: 'run-log',
    role: 'assistant',
    content: `\`\`\`text\n${progress.log.join('\n')}\n\`\`\``,
    toolCalls: [],
    createdAt: progress.startedAt,
  }
}

/** The tool call the card is, rebuilt whole from one progress snapshot. */
export function containerRunToolCall(progress: ContainerRunProgress): ToolCall {
  const id = containerRunToolCallId(progress)
  const status = cardStatus(progress)
  const args: ContainerRunToolArgs = {
    task: progress.prompt,
    model: progress.model,
    runtimeId: progress.runtimeId,
    ref: progress.record?.carryOut.ref ?? null,
  }
  const transcript = progress.record?.transcript ?? []
  const log = logMessage(progress)
  const session: SubagentSession = {
    id: progress.runtimeId ?? id,
    kind: 'container',
    status,
    prompt: progress.prompt,
    summary: containerRunSummary(progress),
    messages: log ? [...transcript, log] : transcript,
    model: progress.model,
  }
  if (progress.record?.result) {
    session.usage = {
      inputTokens: progress.record.result.usage.inputTokens,
      outputTokens: progress.record.result.usage.outputTokens,
    }
  }
  return {
    id,
    name: CONTAINER_RUN_TOOL,
    args,
    status,
    result: containerRunResultMarkdown(progress),
    resultFormat: 'markdown',
    subagent: session,
  }
}

/**
 * Write the run into its thread: the existing card is updated in place, a
 * first snapshot gets a new assistant message to sit on. A thread whose
 * transcript is not in memory is left alone — the card is written when the
 * thread is next shown, from the run the main process still holds.
 */
export function syncContainerRunCard(
  store: AppStore,
  progress: ContainerRunProgress,
): 'added' | 'updated' | 'skipped' {
  const thread = getThreadById(store, progress.threadId)
  if (!thread || thread.messagesLoaded === false) return 'skipped'
  const toolCall = containerRunToolCall(progress)
  const owner = findToolCallOwner(store, progress.threadId, toolCall.id)
  if (owner !== undefined) {
    updateToolCall(store, owner, toolCall.id, toolCall)
    return 'updated'
  }
  const messageId = addMessage(store, progress.threadId, 'assistant', '')
  addToolCall(store, messageId, toolCall)
  return 'added'
}

/** Note a follow-up on the card, so the thread says the commits are in its checkout. */
export function noteAdoptionOnCard(
  store: AppStore,
  threadId: string,
  toolCallId: string,
  adoption: { applied: string[]; alreadyApplied: number },
): void {
  const owner = findToolCallOwner(store, threadId, toolCallId)
  if (owner === undefined) return
  const thread = getThreadById(store, threadId)
  const existing =
    thread?.messages
      .find((message) => message.id === owner)
      ?.toolCalls.find((toolCall) => toolCall.id === toolCallId)?.result ?? ''
  const note =
    adoption.applied.length === 0
      ? `**Already in this checkout** (${plural(adoption.alreadyApplied, 'commit')}).`
      : `**Applied to this checkout:** ${plural(adoption.applied.length, 'commit')}${
          adoption.alreadyApplied > 0 ? ` (${String(adoption.alreadyApplied)} already present)` : ''
        }`
  updateToolCall(store, owner, toolCallId, {
    result: existing.length > 0 ? `${existing}\n\n${note}` : note,
  })
}
