import { isRecord } from '@shared/unknown-value.ts'
import type { ReviewerInputAnswer, Thread, ToolCall } from '@shared/types'

export const REVIEWER_INPUT_TOOL = 'request_review_input'

export interface ReviewerInputRequest {
  /** The tool call is the durable identity of the request. */
  id: string
  messageId: string
  question: string
  context: string
  recommendation?: string
  options: string[]
}

export function isReviewerInputCall(call: ToolCall): boolean {
  return [call.name, call.programmaticName].some(
    (name) =>
      name === REVIEWER_INPUT_TOOL ||
      (typeof name === 'string' &&
        /^(?:mcp[^a-z0-9]+)?copse[^a-z0-9]+request_review_input(?![a-z0-9_])/i.test(name)),
  )
}

export function parseReviewerInputCall(
  call: ToolCall,
  messageId: string,
): ReviewerInputRequest | null {
  if (!isReviewerInputCall(call) || call.status !== 'done' || !isRecord(call.args)) return null
  const { question, context, recommendation, options } = call.args
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

export function reviewerInputRequests(thread: Thread): ReviewerInputRequest[] {
  return thread.messages.flatMap((message) =>
    message.toolCalls
      .map((call) => parseReviewerInputCall(call, message.id))
      .filter((request) => request !== null),
  )
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
