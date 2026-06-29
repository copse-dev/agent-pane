import { defineTool } from '@shared/types'
import {
  askUserParamsSchema,
  formatAnswersResult,
  pairQuestionsWithAnswers,
} from '@shared/agent/ask-user-format.ts'
import { requestUserAnswers } from '../services/ask-user.ts'

export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    "Ask the user one or more clarifying questions and BLOCK until they answer. Use this at unclear or branching points — ambiguous requirements, a choice between approaches, or missing information you cannot safely guess — instead of assuming. Each question may include suggested `options`, but the user can always type their own answer. The tool result contains the user's answers; do not call it for things you can determine yourself.",
  parameters: askUserParamsSchema,
  async execute({ questions }) {
    const { answers } = await requestUserAnswers({ questions })
    return formatAnswersResult(pairQuestionsWithAnswers(questions, answers))
  },
})
