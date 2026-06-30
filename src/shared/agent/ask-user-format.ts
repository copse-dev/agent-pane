import { z } from 'zod'

/**
 * A single clarifying question the agent asks the user. `options` are optional
 * suggested answers the UI can render as quick-pick buttons; the user is always
 * free to type their own answer instead.
 */
export const askUserQuestionSchema = z.object({
  question: z.string().min(1).describe('The clarifying question to ask the user.'),
  options: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe('Optional suggested answers the user can pick from instead of typing.'),
})

export const askUserParamsSchema = z.object({
  questions: z
    .array(askUserQuestionSchema)
    .min(1)
    .max(10)
    .describe('One or more clarifying questions to ask the user before continuing.'),
})

export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>
export type AskUserParams = z.infer<typeof askUserParamsSchema>

/** One question paired with the answer the user gave (or left blank). */
export interface AskUserAnswer {
  question: string
  answer: string
}

/**
 * Build the human-readable body shown to the user for a set of questions. Kept
 * pure (no DOM/IPC) so it can be unit-tested and reused by headless hosts. A
 * single question renders as a plain line; multiple questions are numbered.
 */
export function formatQuestionsBody(questions: AskUserQuestion[]): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const prefix = questions.length > 1 ? `${String(i + 1)}. ` : ''
    lines.push(`${prefix}${q.question}`)
    if (q.options && q.options.length > 0) {
      for (const option of q.options) lines.push(`   - ${option}`)
    }
  })
  return lines.join('\n')
}

/**
 * Format the user's answers into the string fed back as the tool result. Blank
 * answers are reported explicitly as "(no answer)" so the agent can tell a
 * skipped question apart from an empty one rather than silently dropping it.
 * A single question returns just its answer; multiple questions are echoed with
 * their prompts so the agent can map each answer back to its question.
 */
export function formatAnswersResult(answers: AskUserAnswer[]): string {
  if (answers.length === 0) return 'The user did not answer.'
  const normalize = (answer: string): string => {
    const trimmed = answer.trim()
    return trimmed.length > 0 ? trimmed : '(no answer)'
  }
  if (answers.length === 1) {
    const only = answers[0]
    if (!only) return 'The user did not answer.'
    return `The user answered: ${normalize(only.answer)}`
  }
  const lines = ['The user answered:']
  for (const { question, answer } of answers) {
    lines.push(`- ${question} → ${normalize(answer)}`)
  }
  return lines.join('\n')
}

/**
 * Pair up the questions that were asked with the answers that came back,
 * tolerating a short/long answer array: missing answers become empty strings and
 * extra answers are dropped. Keeps {@link formatAnswersResult} total even when a
 * transport returns a mismatched payload.
 */
export function pairQuestionsWithAnswers(
  questions: AskUserQuestion[],
  rawAnswers: string[],
): AskUserAnswer[] {
  return questions.map((q, i) => ({ question: q.question, answer: rawAnswers[i] ?? '' }))
}
