import { z } from 'zod'
import { defineTool } from '@shared/types'
import { requestQuestion } from '../services/question.ts'

const MAX_CHOICES = 10

export const askQuestionTool = defineTool({
  name: 'ask_question',
  description:
    'Ask the user a clarifying question and block until they answer. Use when the ' +
    'prompt is ambiguous, you need a decision at a branching point, or you are ' +
    'missing information only the user can provide. Prefer this over guessing. ' +
    'Ask one focused question at a time; offer choices when the answer is a small ' +
    'set of options. The user may always reply free-form instead of picking a choice.',
  parameters: z.object({
    question: z.string().min(1).describe('The single, focused question to ask the user'),
    choices: z
      .array(z.string().min(1))
      .max(MAX_CHOICES)
      .optional()
      .describe('Optional suggested answers to offer as quick picks'),
  }),
  async execute({ question, choices }) {
    const response = await requestQuestion({ question, choices })
    if (response.cancelled || response.answer.trim() === '') {
      return 'The user did not answer the question. Proceed using your best judgement and state any assumptions you make.'
    }
    return `The user answered: ${response.answer}`
  },
})
