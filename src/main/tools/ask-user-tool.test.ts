import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { askUserTool } from './ask-user-tool.ts'
import { setAskUserHandler, type AskUserRequest } from '../services/ask-user.ts'

const signal = new AbortController().signal

describe('askUserTool', () => {
  afterEach(() => {
    setAskUserHandler(null)
  })

  it('declares the ask_user tool with a questions schema', () => {
    assert.equal(askUserTool.name, 'ask_user')
    assert.equal(
      askUserTool.parameters.safeParse({ questions: [{ question: 'Hi?' }] }).success,
      true,
    )
    assert.equal(askUserTool.parameters.safeParse({ questions: [] }).success, false)
  })

  it('forwards the questions to the handler and formats the single answer', async () => {
    let received: AskUserRequest | null = null
    setAskUserHandler(async (r) => {
      received = r
      return { answers: ['Postgres'] }
    })
    const result = await askUserTool.execute({ questions: [{ question: 'Which DB?' }] }, signal)
    assert.equal(result, 'The user answered: Postgres')
    assert.deepEqual(received, { questions: [{ question: 'Which DB?' }] })
  })

  it('formats multiple answers against their questions', async () => {
    setAskUserHandler(async () => ({ answers: ['Postgres', 'Yes'] }))
    const result = await askUserTool.execute(
      { questions: [{ question: 'Which DB?' }, { question: 'Async?' }] },
      signal,
    )
    assert.equal(result, 'The user answered:\n- Which DB? → Postgres\n- Async? → Yes')
  })

  it('reports a blank answer when no handler resolves (no deadlock)', async () => {
    setAskUserHandler(null)
    const result = await askUserTool.execute({ questions: [{ question: 'Which DB?' }] }, signal)
    assert.equal(result, 'The user answered: (no answer)')
  })

  // Stopping the run withdraws the question; it must not be reported as a
  // question the user answered by leaving it blank. The loop records a thrown
  // tool as an error, so the transcript card does not show a success check.
  it(
    'fails as cancelled, not answered, when the run stops while waiting for the user',
    { timeout: 500 },
    async () => {
      setAskUserHandler(() => new Promise(() => {}))
      const controller = new AbortController()
      const pending = askUserTool.execute(
        { questions: [{ question: 'Which DB?' }] },
        controller.signal,
      )

      controller.abort()

      await assert.rejects(async () => await pending, /stopped before the user answered/)
    },
  )

  it('keeps an answer that arrived before the run stopped', async () => {
    const controller = new AbortController()
    setAskUserHandler(async () => ({ answers: ['Postgres'] }))

    const result = await askUserTool.execute(
      { questions: [{ question: 'Which DB?' }] },
      controller.signal,
    )
    controller.abort()

    assert.equal(result, 'The user answered: Postgres')
  })
})
