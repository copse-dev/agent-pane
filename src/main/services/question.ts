/**
 * Interactive question/answer transport.
 *
 * Mirrors the approval transport (see {@link ./approval.ts}): the agent can pick
 * the `ask_question` tool to clarify an ambiguous prompt or branch decision, and
 * the tool blocks on the user's answer. The GUI registers a handler that surfaces
 * the question in the chat and resolves once the user replies; a headless host can
 * register its own. With no handler set, the request resolves to an empty answer
 * rather than hanging, so a tool call can never block forever.
 */

export interface QuestionRequest {
  /** The question to put to the user. */
  question: string
  /**
   * Optional suggested answers the UI may render as quick-pick choices. The user
   * is never restricted to these — a free-form answer is always allowed.
   */
  choices?: string[]
}

export interface QuestionResponse {
  /** The user's answer, or an empty string when no answer was given. */
  answer: string
  /** True when the user declined / dismissed without answering. */
  cancelled: boolean
}

/**
 * Transport that actually asks the user. The GUI registers an IPC-backed handler;
 * a headless host maps it to its own channel. With no handler set, questions
 * resolve to an empty, cancelled answer rather than being left hanging.
 */
export type QuestionHandler = (req: QuestionRequest) => Promise<QuestionResponse>

let handler: QuestionHandler | null = null

export function setQuestionHandler(next: QuestionHandler | null): void {
  handler = next
}

export function requestQuestion(req: QuestionRequest): Promise<QuestionResponse> {
  return handler ? handler(req) : Promise.resolve({ answer: '', cancelled: true })
}
