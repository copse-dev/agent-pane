import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { requestUserAnswers, setAskUserHandler, type AskUserRequest } from './ask-user.ts'

const req: AskUserRequest = {
  questions: [{ question: 'Which DB?', options: ['Postgres'] }, { question: 'Async?' }],
}

describe('requestUserAnswers pluggable transport', () => {
  afterEach(() => {
    setAskUserHandler(null)
  })

  it('returns blank answers (without hanging) when no handler is registered', async () => {
    setAskUserHandler(null)
    assert.deepEqual(await requestUserAnswers(req), { answers: ['', ''] })
  })

  it('routes the request to the registered handler', async () => {
    const seen: AskUserRequest[] = []
    setAskUserHandler(async (r) => {
      seen.push(r)
      return { answers: ['Postgres', 'Yes'] }
    })
    assert.deepEqual(await requestUserAnswers(req), { answers: ['Postgres', 'Yes'] })
    assert.deepEqual(seen, [req])
  })

  it('reverts to blank answers once the handler is cleared', async () => {
    setAskUserHandler(async () => ({ answers: ['x', 'y'] }))
    assert.deepEqual((await requestUserAnswers(req)).answers, ['x', 'y'])
    setAskUserHandler(null)
    assert.deepEqual((await requestUserAnswers(req)).answers, ['', ''])
  })
})
