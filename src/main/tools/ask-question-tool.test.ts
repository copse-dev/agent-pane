import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { askQuestionTool } from './ask-question-tool.ts'
import {
  setQuestionHandler,
  type QuestionRequest,
  type QuestionResponse,
} from '../services/question.ts'

const signal = new AbortController().signal

async function run(args: { question: string; choices?: string[] }): Promise<string> {
  const result = await askQuestionTool.execute(args, signal)
  return typeof result === 'string' ? result : result.result
}

describe('ask_question tool', () => {
  afterEach(() => {
    setQuestionHandler(null)
  })

  it('forwards the question and choices to the handler', async () => {
    const seen: QuestionRequest[] = []
    setQuestionHandler(async (req): Promise<QuestionResponse> => {
      seen.push(req)
      return { answer: 'TypeScript', cancelled: false }
    })

    const out = await run({ question: 'Which language?', choices: ['TypeScript', 'Go'] })
    assert.deepEqual(seen, [{ question: 'Which language?', choices: ['TypeScript', 'Go'] }])
    assert.match(out, /The user answered: TypeScript/)
  })

  it('returns a proceed-anyway message when the user cancels', async () => {
    setQuestionHandler(async () => ({ answer: '', cancelled: true }))
    const out = await run({ question: 'Continue?' })
    assert.match(out, /did not answer/)
    assert.match(out, /best judgement/)
  })

  it('treats a blank answer as no answer', async () => {
    setQuestionHandler(async () => ({ answer: '   ', cancelled: false }))
    const out = await run({ question: 'Anything?' })
    assert.match(out, /did not answer/)
  })

  it('does not hang when no handler is registered (defaults to cancelled)', async () => {
    setQuestionHandler(null)
    const out = await run({ question: 'Are you there?' })
    assert.match(out, /did not answer/)
  })

  it('rejects an empty question via the schema', () => {
    const parsed = askQuestionTool.parameters.safeParse({ question: '' })
    assert.equal(parsed.success, false)
  })

  it('rejects more than ten choices via the schema', () => {
    const choices = Array.from({ length: 11 }, (_, i) => `choice-${String(i)}`)
    const parsed = askQuestionTool.parameters.safeParse({ question: 'Pick', choices })
    assert.equal(parsed.success, false)
  })
})
