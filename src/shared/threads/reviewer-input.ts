import { isRecord } from '@shared/unknown-value.ts'
import type { ReviewerInputAnswer, Thread, ToolCall } from '@shared/types'
import { isCopseToolCall } from '@shared/tools/copse-tool-call.ts'
import { splitAppendedReminders } from '@shared/tools/tool-result-reminders.ts'
import {
  askUserParamsSchema,
  parseDeferredAskUserResult,
  type AskUserParams,
} from '@copse/agent/ask-user-format.ts'

export const REVIEWER_INPUT_TOOL = 'request_review_input'

export interface ReviewerInputRequest {
  /** The tool call is the durable identity of the request. */
  id: string
  /** Several deferred ask_user questions can share one transcript tool card. */
  toolCallId?: string
  messageId: string
  question: string
  context: string
  recommendation?: string
  options: string[]
}

export function isReviewerInputCall(call: ToolCall): boolean {
  return isCopseToolCall(call, REVIEWER_INPUT_TOOL) || isDeferredAskUserCall(call)
}

/** Hook notes are separate from tool output only when recorded by the registry. */
function isDeferredAskUserCall(call: ToolCall): boolean {
  return deferredAskUserParams(call) !== null
}

function deferredAskUserParams(call: ToolCall): AskUserParams | null {
  if (
    !isCopseToolCall(call, 'ask_user') ||
    call.status !== 'done' ||
    !askUserParamsSchema.safeParse(reviewerInputArguments(call)).success
  )
    return null
  return parseDeferredAskUserResult(
    splitAppendedReminders(call.result ?? '', call.appendedReminderLengths).output,
  )
}

export function parseReviewerInputCall(
  call: ToolCall,
  messageId: string,
): ReviewerInputRequest | null {
  const args = reviewerInputArguments(call)
  if (!isCopseToolCall(call, REVIEWER_INPUT_TOOL) || call.status !== 'done' || !isRecord(args))
    return null
  const { question, context, recommendation, options } = args
  if (
    typeof question !== 'string' ||
    question.trim() === '' ||
    typeof context !== 'string' ||
    context.trim() === ''
  ) {
    return null
  }
  const validOptions = Array.isArray(options)
    ? options.flatMap((value: unknown) =>
        typeof value === 'string' && value.trim() !== '' ? [value] : [],
      )
    : []
  return {
    id: call.id,
    messageId,
    question: question.trim().slice(0, 300),
    context: context.trim().slice(0, 1200),
    ...(typeof recommendation === 'string' && recommendation.trim() !== ''
      ? { recommendation: recommendation.trim().slice(0, 600) }
      : {}),
    options: validOptions.slice(0, 4).map((value) => value.trim().slice(0, 120)),
  }
}

/** ACP can retain the MCP dispatch envelope around the tool's own arguments. */
function reviewerInputArguments(call: ToolCall): unknown {
  const args = call.args
  if (
    isRecord(args) &&
    args['server'] === 'copse' &&
    typeof args['tool'] === 'string' &&
    isCopseToolCall(call, args['tool']) &&
    Object.hasOwn(args, 'arguments')
  )
    return args['arguments']
  return args
}

export function reviewerInputRequests(thread: Thread): ReviewerInputRequest[] {
  return thread.messages.flatMap((message) =>
    message.toolCalls.flatMap((call) => reviewerInputRequestsForCall(call, message.id)),
  )
}

/** Both saved-question tools use the same answer panel and transcript anchors. */
export function reviewerInputRequestsForCall(
  call: ToolCall,
  messageId: string,
): ReviewerInputRequest[] {
  const review = parseReviewerInputCall(call, messageId)
  return review ? [review] : deferredAskUserRequests(call, messageId)
}

/** The completed native tool call keeps every question durable, without another store. */
function deferredAskUserRequests(call: ToolCall, messageId: string): ReviewerInputRequest[] {
  const parsed = deferredAskUserParams(call)
  if (!parsed) return []
  return parsed.questions.map((question, index) => ({
    id: `${call.id}:question:${String(index)}`,
    toolCallId: call.id,
    messageId,
    question: question.question,
    context: 'Saved during an unattended run. Your answer will be sent as a follow-up message.',
    options: question.options ?? [],
    ...(question.recommendedOption && question.recommendationReason
      ? { recommendation: `${question.recommendedOption} — ${question.recommendationReason}` }
      : {}),
  }))
}

export function reviewerInputAnswer(answers: unknown, id: string): ReviewerInputAnswer | undefined {
  return parseReviewerInputAnswers(answers).find((answer) => answer.id === id)
}

/** Decode optional persisted answers before renderer code treats them as a list. */
export function parseReviewerInputAnswers(value: unknown): ReviewerInputAnswer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry['id'] !== 'string' ||
      typeof entry['text'] !== 'string' ||
      typeof entry['answeredAt'] !== 'number' ||
      !Number.isFinite(entry['answeredAt']) ||
      typeof entry['messageId'] !== 'string'
    ) {
      return []
    }
    return [
      {
        id: entry['id'],
        text: entry['text'],
        answeredAt: entry['answeredAt'],
        messageId: entry['messageId'],
      },
    ]
  })
}
