import { defineTool } from '@shared/types'
import {
  askUserParamsSchema,
  formatAnswersResult,
  pairQuestionsWithAnswers,
} from '@copse/agent/ask-user-format.ts'
import { requestUserAnswers } from '../services/ask-user.ts'

export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    "Ask for missing information or a consequential scope decision that blocks progress, and BLOCK until the user answers. Resolve routine implementation choices from the request and available evidence. Do not use this to repeat an existing approval, duplicate a tool's approval prompt, or report a diagnosis that needs no user decision. Each question may include suggested `options`, but the user can always type their own answer. The tool result contains the user's answers.",
  parameters: askUserParamsSchema,
  async execute({ questions }, signal) {
    const { answers } = await requestUserAnswers({ questions }, signal)
    return formatAnswersResult(pairQuestionsWithAnswers(questions, answers))
  },
})
